"""leakage_check.py 测试（T7，评审 §十四：Held-out Transfer 泄漏检查）。

预注册口径（见 leakage_check.py docstring）：
  MemoryLeakageRate = held-out 任务 prompt 与库中 active 卡 source prompt 的
     字符 3-gram Jaccard 相似度 > 0.6 的配对数 / held-out 任务数；目标 = 0
  source_task 解析：payload.taskId（ABILITY 卡，去臂前缀）优先；
     回落 payload.sourceSession → session 头 metadata.task_id；
     均取不到时用卡片 content 全文比对（近似，docstring 注明）
  future-task 提前入库：source_task ∈ held-out 且 created_at < 该任务首跑日
     （held-out 首跑 = D7 = campaign 开始日 + 6 天）的 active 卡 = 违规
"""

import json
import sqlite3
import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import leakage_check as lc  # noqa: E402

SCHEMA = """
CREATE TABLE experiences (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    payload TEXT NOT NULL,
    quality REAL NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 0.5,
    rescore_excluded_batches INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    branch_path TEXT,
    times_selected INTEGER NOT NULL DEFAULT 0,
    source_session TEXT NOT NULL,
    source_entry_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def make_db(experiences=None):
    con = sqlite3.connect(":memory:")
    con.executescript(SCHEMA)
    for row in experiences or []:
        con.execute(
            "INSERT INTO experiences (id, type, title, payload, quality, confidence, status,"
            " source_session, source_entry_id, content_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            row,
        )
    con.commit()
    return con


def _card(card_id, payload, status="active", created_at="2026-08-19T00:00:00Z", type_="ABILITY"):
    return (card_id, type_, "t", json.dumps(payload), 0.8, 0.5, status, "s.jsonl", "e1", "h1", created_at)


# ── 文本相似度 ──


def test_char_trigrams_and_jaccard():
    a = "inspect the workspace config"
    b = "inspect the workspace config"
    assert lc.char_trigrams(a) == lc.char_trigrams(b)
    assert lc.jaccard_sim(a, b) == 1.0
    assert lc.jaccard_sim("aaaa bbbb", "cccc dddd") == 0.0
    # 短文本（<3 字符）不炸
    assert lc.jaccard_sim("ab", "ab") == 1.0


# ── source_task 解析 ──


def test_normalize_task_id_strips_arm_prefix():
    assert lc.normalize_task_id("control-task_00002_workspace_x") == "task_00002_workspace_x"
    assert lc.normalize_task_id("experiment-task_00019_y") == "task_00019_y"
    assert lc.normalize_task_id("task_00002_workspace_x") == "task_00002_workspace_x"
    assert lc.normalize_task_id("nonsense") == "nonsense"


def test_resolve_source_task_from_payload_task_id():
    payload = {"taskId": "experiment-task_00001_a", "role": "Method", "procedure": "1) cat x"}
    assert lc.resolve_source_task(payload, []) == "task_00001_a"


def test_resolve_source_task_from_session_file(tmp_path):
    sess_dir = tmp_path / "sessions"
    sess_dir.mkdir()
    sess = sess_dir / "control-task_00002_b.jsonl"
    sess.write_text(json.dumps({"type": "session", "metadata": {"task_id": "task_00002_b"}}) + "\n")
    payload = {"sourceSession": str(sess)}
    assert lc.resolve_source_task(payload, []) == "task_00002_b"
    # 相对路径 + session dirs 搜索
    payload2 = {"sourceSession": "eval/sessions-synth/campaign-d1/control-task_00002_b.jsonl"}
    assert lc.resolve_source_task(payload2, [sess_dir]) == "task_00002_b"


def test_resolve_source_task_unresolved(tmp_path):
    assert lc.resolve_source_task({"procedure": "1) cat x"}, [tmp_path]) == ""
    assert lc.resolve_source_task({"sourceSession": "var/sessions/missing.jsonl"}, [tmp_path]) == ""


def test_card_source_prompt_fallback_to_content():
    # 无法解析 source_task → 用卡 content 全文比对（近似，docstring 注明）
    payload = {"role": "Method", "procedure": "1) inspect the workspace config"}
    task_id, text, resolved = lc.card_source_prompt(payload, [], task_prompt_fn=None)
    assert task_id is None
    assert resolved is False
    assert "inspect the workspace config" in text


def test_card_source_prompt_resolved():
    payload = {"taskId": "task_00001_a", "procedure": "1) cat x"}
    task_id, text, resolved = lc.card_source_prompt(payload, [], task_prompt_fn=lambda tid: f"PROMPT:{tid}")
    assert task_id == "task_00001_a"
    assert text == "PROMPT:task_00001_a"
    assert resolved is True


# ── MemoryLeakageRate ──


def test_memory_leakage_rate_clean_library():
    # 库中卡片全部来自重复集任务（held-out 无 near-duplicate）
    cards = [
        {"id": "c1", "source_task": "task_00002_repeat_a", "prompt": "unrelated prompt text", "resolved": True},
        {"id": "c2", "source_task": "task_00019_repeat_b", "prompt": "another unrelated prompt text", "resolved": True},
    ]
    held_prompts = {"task_00050_h": "held out prompt number fifty", "task_00051_h": "held out prompt fifty one"}
    res = lc.memory_leakage_rate(held_prompts, cards, threshold=0.6)
    assert res["rate"] == 0.0
    assert res["pairs"] == []
    assert res["n_held_out"] == 2
    assert res["target"] == 0


def test_memory_leakage_rate_exact_leak():
    # 卡片 source_task 就是 held-out 任务 → prompt 完全一致 → 相似度 1.0
    held_prompts = {"task_00050_h": "held out prompt number fifty"}
    cards = [{"id": "c1", "source_task": "task_00050_h", "prompt": "held out prompt number fifty", "resolved": True}]
    res = lc.memory_leakage_rate(held_prompts, cards, threshold=0.6)
    assert res["rate"] == 1.0
    assert res["pairs"][0]["similarity"] == 1.0
    assert res["pairs"][0]["card_id"] == "c1"


def test_memory_leakage_rate_template_duplicate():
    # 不同 task_id 但模板相同（对象 ID 不同）→ near-duplicate 检出
    held_prompts = {"task_00050_h": "create a report for object 42 with config file"}
    cards = [{"id": "c1", "source_task": "task_00099_other", "prompt": "create a report for object 17 with config file", "resolved": True}]
    res = lc.memory_leakage_rate(held_prompts, cards, threshold=0.6)
    assert res["rate"] == 1.0


def test_leakage_fallback_paraphrased_content_misses():
    # 方向定性（复核报告）：source_task 解析失败的卡回落 content 全文比对；
    # 蒸馏改写后的 content 与原始 prompt 文本差异大 → 相似度 < 阈值 → 漏检。
    # fallback 偏向假阴性（漏检）方向——真实泄漏可能被漏掉，需结合 future-task
    # 检查与 source 解析率审计使用。
    held_prompts = {"task_00050_h": "create a monitoring dashboard with alerts for every service"}
    cards = [
        {"id": "c1", "source_task": None,
         "prompt": "1) 初始化监控配置 2) 设置告警规则 3) 验证指标采集", "resolved": False}
    ]
    res = lc.memory_leakage_rate(held_prompts, cards, threshold=0.6)
    assert res["rate"] == 0.0  # 同源真实泄漏被漏检（假阴性方向）


def test_memory_leakage_rate_unresolved_fallback_cards():
    # 未解析 source_task 的卡用 content 全文比对
    held_prompts = {"task_00050_h": "set up the monitoring dashboard"}
    cards = [{"id": "c1", "source_task": None, "prompt": "set up the monitoring dashboard", "resolved": False}]
    res = lc.memory_leakage_rate(held_prompts, cards, threshold=0.6)
    assert res["rate"] == 1.0
    assert res["pairs"][0]["fallback"] is True


# ── future-task 提前入库 ──


def test_future_task_violations():
    held = {"task_00050_h": "2026-08-25"}  # held-out 首跑日（D7）
    cards = [
        {"id": "c1", "source_task": "task_00050_h", "created_at": "2026-08-19T00:00:00Z"},  # 提前入库 → 违规
        {"id": "c2", "source_task": "task_00050_h", "created_at": "2026-08-26T00:00:00Z"},  # 首跑后 → 合规
        {"id": "c3", "source_task": "task_00002_a", "created_at": "2026-08-01T00:00:00Z"},  # 非 held-out → 无关
    ]
    violations = lc.future_task_violations(cards, held)
    assert [v["card_id"] for v in violations] == ["c1"]


# ── CLI 端到端（tmp 环境，不碰真实库） ──


def test_report_unresolved_ratio_and_conclusion(tmp_path):
    # pi-test 观察项-泄漏 fallback：source 解析失败回落 content 比对会假阴性；
    # 报表必须带 unresolved 审计——unresolved_ratio > 0.2（预注册）→ conclusion="degraded"
    db_path = tmp_path / "u.db"
    con = sqlite3.connect(str(db_path))
    con.executescript(SCHEMA)
    for row in [
        _card("c1", {"taskId": "task_00001_a", "procedure": "p"}),  # 解析成功
        _card("c2", {"procedure": "1) cat x"}),  # 解析失败
        _card("c3", {"sourceSession": "var/sessions/missing.jsonl"}),  # 解析失败
    ]:
        con.execute(
            "INSERT INTO experiences (id, type, title, payload, quality, confidence, status,"
            " source_session, source_entry_id, content_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            row,
        )
    con.commit()
    con.close()
    res = lc.report(
        db_path=db_path,
        held_ids=["task_00050_h"],
        first_run_dates={"task_00050_h": "2026-08-25"},
        task_prompt_fn=lambda tid: "p",  # 可解析任务 id 均能取到 prompt（c1 解析成功）
        session_dirs=[tmp_path],
    )
    assert res["n_cards_checked"] == 3
    assert res["unresolved_n"] == 2
    assert res["unresolved_ratio"] == pytest.approx(2 / 3)
    assert res["conclusion"] == "degraded"


def test_report_unresolved_ratio_ok_and_boundary(tmp_path):
    db_path = tmp_path / "ok.db"
    con = sqlite3.connect(str(db_path))
    con.executescript(SCHEMA)
    rows = [_card(f"c{i}", {"taskId": f"task_{i:05d}_x", "procedure": "p"}) for i in range(4)]
    rows.append(_card("cu", {"procedure": "1) cat x"}))  # 1/5 未解析 = 0.2，恰在阈值 → 不降级（严格 >）
    for row in rows:
        con.execute(
            "INSERT INTO experiences (id, type, title, payload, quality, confidence, status,"
            " source_session, source_entry_id, content_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            row,
        )
    con.commit()
    con.close()
    res = lc.report(
        db_path=db_path,
        held_ids=[],
        first_run_dates={},
        task_prompt_fn=lambda tid: "p",
        session_dirs=[tmp_path],
    )
    assert res["unresolved_n"] == 1
    assert res["unresolved_ratio"] == pytest.approx(0.2)
    assert res["conclusion"] == "ok"  # 阈值严格大于


def test_report_unresolved_all_resolved(tmp_path):
    db_path = tmp_path / "all.db"
    con = sqlite3.connect(str(db_path))
    con.executescript(SCHEMA)
    con.execute(
        "INSERT INTO experiences (id, type, title, payload, quality, confidence, status,"
        " source_session, source_entry_id, content_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        _card("c1", {"taskId": "task_00001_a"}),
    )
    con.commit()
    con.close()
    res = lc.report(
        db_path=db_path,
        held_ids=[],
        first_run_dates={},
        task_prompt_fn=lambda tid: "p",
        session_dirs=[tmp_path],
    )
    assert res["unresolved_n"] == 0
    assert res["unresolved_ratio"] == 0.0
    assert res["conclusion"] == "ok"
    # 空库边界
    empty = tmp_path / "empty.db"
    con2 = sqlite3.connect(str(empty))
    con2.executescript(SCHEMA)
    con2.commit()
    con2.close()
    res2 = lc.report(db_path=empty, held_ids=[], first_run_dates={}, task_prompt_fn=lambda tid: "p", session_dirs=[tmp_path])
    assert res2["unresolved_n"] == 0
    assert res2["conclusion"] == "ok"


def test_cli_end_to_end(tmp_path):
    db_path = tmp_path / "experience.db"
    con = sqlite3.connect(str(db_path))
    con.executescript(SCHEMA)
    for row in [
        _card("c1", {"taskId": "experiment-task_00050_h", "procedure": "held out prompt number fifty"},
              created_at="2026-08-19T00:00:00Z"),
        _card("c2", {"taskId": "task_00002_a", "procedure": "something else entirely different here"},
              created_at="2026-08-01T00:00:00Z"),
    ]:
        con.execute(
            "INSERT INTO experiences (id, type, title, payload, quality, confidence, status,"
            " source_session, source_entry_id, content_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            row,
        )
    con.commit()
    con.close()
    # report 组装（CLI 的 held-out 来自 campaign_plan；测试注入 held 列表）
    res = lc.report(
        db_path=db_path,
        held_ids=["task_00050_h"],
        first_run_dates={"task_00050_h": date(2026, 8, 25)},
        task_prompt_fn={  # held-out prompt 由任务 md 提供；测试注入
            "task_00050_h": "held out prompt number fifty",
        }.get,
        session_dirs=[tmp_path],
        threshold=0.6,
    )
    assert res["memory_leakage_rate"] == 1.0
    assert len(res["leak_pairs"]) == 1
    assert [v["card_id"] for v in res["future_task_violations"]] == ["c1"]
    assert res["future_task_first_run"] == "2026-08-25"
