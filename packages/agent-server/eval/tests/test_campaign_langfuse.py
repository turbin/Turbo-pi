"""campaign.py Langfuse 监视接线测试（2026-08-19）。

契约：未配置 env 时全链路 no-op（零行为变化）；任何上报异常只告警不炸批
（issue-008/009/011 教训）；任务级 trace 与 score 共用同一 seed 对账键。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import campaign  # noqa: E402


def test_init_langfuse_none_without_env(monkeypatch):
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    assert campaign.init_langfuse() is None


def test_init_langfuse_none_with_only_public_key(monkeypatch):
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-lf-x")
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    assert campaign.init_langfuse() is None


def test_init_langfuse_builds_client_with_keys(monkeypatch):
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-lf-x")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-lf-x")
    monkeypatch.setenv("LANGFUSE_HOST", "http://localhost:3000")
    lf = campaign.init_langfuse()
    assert lf is not None
    lf.shutdown()


def test_task_observation_null_when_disabled():
    with campaign.task_observation(None, seed="s", name="n", metadata={}) as obs:
        obs.update(output={"score": 0.5})  # no-op，不抛


def test_report_score_noop_when_disabled():
    campaign.report_score(None, seed="s", score=0.5, comment="x")  # 不抛


class _ExplodingLangfuse:
    def create_trace_id(self, *, seed):
        return f"lf-{seed}"

    def create_score(self, **_kwargs):
        raise RuntimeError("ingestion down")


def test_report_score_swallows_errors(capsys):
    campaign.report_score(_ExplodingLangfuse(), seed="s", score=0.5, comment="x")
    assert "langfuse score failed" in capsys.readouterr().err


class _RecordingLangfuse:
    def __init__(self):
        self.scores = []

    def create_trace_id(self, *, seed):
        return f"lf-{seed}"

    def create_score(self, **kwargs):
        self.scores.append(kwargs)


def test_report_score_uses_seed_derived_trace_id():
    lf = _RecordingLangfuse()
    campaign.report_score(lf, seed="run-d1-x1-task_1", score=0.7, comment="ok")
    assert lf.scores == [
        {
            "name": "qcb_score",
            "value": 0.7,
            "trace_id": "lf-run-d1-x1-task_1",
            "comment": "ok",
        }
    ]


def test_task_observation_with_real_client(monkeypatch):
    # 真实客户端走内存 OTLP 队列，不向网络发请求即可完成 span 生命周期。
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-lf-x")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-lf-x")
    monkeypatch.setenv("LANGFUSE_HOST", "http://localhost:3000")
    lf = campaign.init_langfuse()
    assert lf is not None
    with campaign.task_observation(lf, seed="seed-1", name="task:x1:t", metadata={"arm": "x1"}) as obs:
        obs.update(output={"score": 1.0})
    lf.shutdown()
