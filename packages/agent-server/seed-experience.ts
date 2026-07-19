import { ExperienceStore } from "./src/experience-store.ts";

async function main() {
  const store = new ExperienceStore("./var/experience.db");
  await store.initSchema();

  await store.insert({
    id: "exp-quantum-1",
    type: "EVIDENCE",
    title: "量子计算基础",
    payload: { text: "量子计算利用量子比特（qubit）的叠加态和纠缠态进行并行计算，相比经典比特能指数级提升特定问题的求解速度。" },
    quality: 0.9,
    status: "active",
    sourceSession: "seed",
    sourceEntryId: "seed-1",
    contentHash: "hash-quantum-1",
    createdAt: new Date().toISOString(),
  });

  await store.insert({
    id: "exp-quantum-2",
    type: "EVIDENCE",
    title: "量子比特特性",
    payload: { text: "量子比特可以同时处于 0 和 1 的叠加态，测量时会以一定概率坍缩到确定状态。" },
    quality: 0.85,
    status: "active",
    sourceSession: "seed",
    sourceEntryId: "seed-2",
    contentHash: "hash-quantum-2",
    createdAt: new Date().toISOString(),
  });

  await store.insert({
    id: "exp-method-1",
    type: "ABILITY",
    title: "先写测试",
    payload: { role: "Method", procedure: "在实现功能前，先写一个失败的测试来明确期望行为。" },
    quality: 0.9,
    status: "active",
    sourceSession: "seed",
    sourceEntryId: "seed-3",
    contentHash: "hash-method-1",
    createdAt: new Date().toISOString(),
  });

  await store.insert({
    id: "exp-guard-1",
    type: "ABILITY",
    title: "密钥安全",
    payload: { role: "Guard", boundary: "不得将 API 密钥、密码或私钥提交到版本控制或日志中。" },
    quality: 0.95,
    status: "active",
    sourceSession: "seed",
    sourceEntryId: "seed-4",
    contentHash: "hash-guard-1",
    createdAt: new Date().toISOString(),
  });

  console.log("seeded 4 experiences");
}

main().catch((err) => { console.error(err); process.exit(1); });
