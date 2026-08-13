> 原文：A Comprehensive Survey of Self-Evolving AI Agents: A New Paradigm Bridging Foundation Models and Lifelong Agentic Systems
> 作者：Jinyuan Fang, Yanwen Peng, Xi Zhang, Yingxu Wang, Xinhao Yi, Guibin Zhang, Yi Xu, Bin Wu, Siwei Liu, Zihao Li, Zhaochun Ren, Nikos Aletras, Xi Wang, Han Zhou, Zaiqiao Meng
> arXiv:2508.07407v2 [cs.AI]，2025-08-31，https://arxiv.org/abs/2508.07407
> 来源：Zotero 本地文库（Item QMILJEKB）；全文中文翻译由 AI 完成（pi 子任务分块翻译 + 主会话汇总），仅供参考。
> 说明：正文完整翻译；图表以文字/表格形式还原；文末参考文献保留英文原文。

---

# 自我演化 AI 智能体综述：连接基础模型与终身智能体系统的新范式（A Comprehensive Survey of Self-Evolving AI Agents: A New Paradigm Bridging Foundation Models and Lifelong Agentic Systems）

**Jinyuan Fang\*1, Yanwen Peng\*2, Xi Zhang\*1, Yingxu Wang3, Xinhao Yi1, Guibin Zhang4, Yi Xu5, Bin Wu6, Siwei Liu7, Zihao Li1, Zhaochun Ren8, Nikos Aletras2, Xi Wang2, Han Zhou5, Zaiqiao Meng1✉**

1 格拉斯哥大学（University of Glasgow），2 谢菲尔德大学（University of Sheffield），3 穆罕默德·本·扎耶德人工智能大学（Mohamed bin Zayed University of Artificial Intelligence），4 新加坡国立大学（National University of Singapore），5 剑桥大学（University of Cambridge），6 伦敦大学学院（University College London），7 阿伯丁大学（University of Aberdeen），8 莱顿大学（Leiden University）

\* 共同第一作者（Equal Contributor），✉ 通讯作者（Corresponding Author）

arXiv:2508.07407v2 [cs.AI] 31 Aug 2025

## 摘要（Abstract）

近年来，大语言模型（LLM）的进展激发了对能够解决复杂现实任务的 AI 智能体日益浓厚的兴趣。然而，现有的大多数智能体系统依赖人工设计的配置，部署后保持静态不变，限制了它们适应动态演化环境的能力。为克服这一局限，近期研究探索了旨在基于交互数据与环境反馈自动增强智能体系统的智能体演化（agent evolution）技术。这一新兴方向为自我演化 AI 智能体（self-evolving AI agents）奠定了基础——它们将基础模型（foundation models）的静态能力与终身智能体系统（lifelong agentic systems）所需的持续适应性连接起来。在本综述中，我们对自我演化智能体系统的现有技术进行了全面回顾。具体而言，我们首先引入一个统一概念框架（unified conceptual framework），抽象出自我演化智能体系统设计背后的反馈回路（feedback loop）。该框架突出四个关键组件：系统输入（System Inputs）、智能体系统（Agent System）、环境（Environment）与优化器（Optimisers），为理解与比较不同策略提供了基础。基于该框架，我们系统性地回顾了针对智能体系统不同组件的大量自我演化技术，包括基础模型、智能体提示词（prompt）、记忆（memory）、工具（tool）、工作流（workflow）以及智能体间的通信机制。我们还考察了为生物医学、编程、金融等专门领域开发的领域特定演化策略，在这些领域中，智能体行为与优化目标同领域约束紧密耦合。此外，我们专门讨论了自我演化智能体系统的评估（evaluation）、安全（safety）与伦理考量（ethical considerations），这些对于确保其有效性与可靠性至关重要。本综述旨在为研究人员与实践者提供对自我演化 AI 智能体的系统性理解，为开发更具适应性、自主性与终身性的智能体系统奠定基础。

GitHub：https://github.com/EvoAgentX/Awesome-Self-Evolving-Agents

## 1 引言（Introduction）

近年来，大语言模型（large language models, LLM）的进展显著推动了人工智能（artificial intelligence, AI）的发展。得益于大规模预训练、监督微调与强化学习的进步，LLM 在规划、推理与自然语言理解方面展现出了卓越能力（Zhao et al., 2023; Grattafiori et al., 2024; Yang et al., 2025a; Guo et al., 2025）。这些进展激发了对基于 LLM 的智能体（LLM-based agents，即以 LLM 作为决策/策略模块的 AI 智能体子类）日益浓厚的兴趣（Wang et al., 2024c; Luo et al., 2025a）。智能体（agent）是在开放式的现实环境中，以 LLM 为核心推理组件来理解输入、规划行动并生成输出的自主系统（Wang et al., 2024c; Xi et al., 2025; Luo et al., 2025a）。一个典型的 AI 智能体由多个组件构成，使其能够以自主方式执行复杂、目标导向的任务。基础模型（如 LLM）是核心，负责解释目标、制定计划并执行动作。为支撑这些能力，还需要集成感知（perception）（Shridhar et al., 2021; Zheng et al., 2024）、规划（planning）（Yao et al., 2023a,b; Besta et al., 2024）、记忆（memory）（Modarressi et al., 2023; Zhong et al., 2024）与工具（tools）（Schick et al., 2023; Gou et al., 2024; Liu et al., 2025g）等附加模块，帮助智能体感知输入、分解任务、保留上下文信息并与工具交互（Wang et al., 2024c）。

arXiv:2508.07407v2 [cs.AI] 31 Aug 2025

**图 1（Figure 1）** 以 LLM 为中心的学习正从仅从静态数据学习，演进到与动态环境交互，并最终迈向通过多智能体协作与自我演化实现终身学习。

尽管单智能体系统已在各类任务中展现出强大的泛化能力与适应性，但在动态复杂环境中，它们往往难以实现任务专精与协调（Wu et al., 2024a; Qian et al., 2024）。这些局限催生了多智能体系统（multi-agent systems, MAS）的发展（Hong et al., 2024; Guo et al., 2024c; Zhou et al., 2025a），在 MAS 中，多个智能体协作解决复杂问题。与单智能体系统相比，MAS 实现了功能专精，每个智能体针对特定子任务或专业领域而设计。此外，智能体之间可以交互、交换信息并协调行为，以实现共同目标。这种协作使系统能够应对超出单个智能体能力的任务，同时模拟更真实、动态且交互的环境。基于 LLM 的智能体系统已成功应用于广泛的现实任务，从代码生成（Jiang et al., 2024）、科学研究（Lu et al., 2024a）、网页导航（Lai et al., 2024a），到生物医学（Kim et al., 2024）与金融（Tian et al., 2025）等领域的特定应用。

尽管智能体系统取得了显著进展，但其中大多数（无论是单智能体还是多智能体）仍然严重依赖人工设计的配置。一旦部署，这些系统通常保持静态架构与固定功能。然而，现实环境是动态且持续演化的，例如用户意图会转变、任务需求会变化、外部工具或信息来源可能随时间而变。例如，辅助客服的智能体可能需要处理新推出的产品、更新的公司政策或陌生的用户意图。类似地，科学研究助理可能需要纳入新发表的算法，或集成新颖的分析工具。在这种情况下，人工重新配置智能体系统耗时费力，且难以扩展。

这些挑战促使近期工作探索自我演化 AI 智能体（Self-Evolving AI Agents）这一新范式——一类能够自主适应并持续自我改进的新型智能体系统，将基础模型与终身学习智能体系统连接起来。

**定义（Definition）**

自我演化 AI 智能体是指能够通过与环境的交互持续、系统性地优化其内部组件的自主系统，其目标是在保持安全性的同时提升性能，并适应不断变化的任务、情境与资源。

受艾萨克·阿西莫夫"机器人三定律"（Three Laws of Robotics）¹ 的启发，我们提出一套指导 AI 智能体安全、有效自我演化的原则：

**自我演化 AI 智能体三定律（Three Laws of Self-Evolving AI Agents）**

I. 承受（安全适应，Safety Adaptation）：自我演化 AI 智能体在任何修改过程中都必须保持安全与稳定；
II. 卓越（性能保持，Performance Preservation）：在不违反第一定律的前提下，自我演化 AI 智能体必须保持或提升现有任务性能；
III. 演化（自主演化，Autonomous Evolution）：在不违反第一、第二定律的前提下，自我演化 AI 智能体必须能够根据变化的任务、环境或资源自主优化其内部组件。

¹ 出自其小说《转圈圈》（Runaround，1942）与《我，机器人》（I, Robot，1950）。这些定律具有层级性：第二定律不能凌驾于第一定律之上，第三定律不能凌驾于第一或第二定律之上。尽管最初被构想为虚构的道德约束，它们已成为 AI 伦理研究中具有影响力的思想。因此，我们阐述"自我演化 AI 智能体三定律"，主张 AI 智能体作为具身智能（embodied AI）的核心，应在追求自主演化之前优先考虑合规与安全。

我们将自我演化 AI 智能体的出现视为基于 LLM 的系统开发中更广泛范式转变的一部分。这一转变从早期的模型离线预训练（Model Offline Pretraining, MOP）与模型在线适应（Model Online Adaptation, MOA），到近年来的多智能体编排（Multi-Agent Orchestration, MAO）趋势，最终走向多智能体自我演化（Multi-Agent Self-Evolving, MASE）。如图 1 与表 1 所总结，每一种范式都建立在前一种范式之上，从静态、冻结的基础模型走向完全自主、自我演化的智能体系统。

- **MOP（模型离线预训练，Model Offline Pretraining）**。初始阶段专注于在大规模静态语料上预训练基础模型，然后以固定、冻结的状态部署，不再进行任何适应。
- **MOA（模型在线适应，Model Online Adaptation）**。在 MOP 的基础上，该阶段引入部署后适应，基础模型可通过监督微调、低秩适配器（low-rank adapters）（Pfeiffer et al., 2021; Hu et al., 2022）或基于人类反馈的强化学习（RLHF）（Ouyang et al., 2022）等技术，利用标签、评分或指令提示进行更新。
- **MAO（多智能体编排，Multi-Agent Orchestration）**。该阶段超越单一基础模型，协调多个 LLM 智能体，通过消息交换或辩论提示（Li et al., 2024g; Zhang et al., 2025h）进行通信与协作，在不修改底层模型参数的前提下解决复杂任务。
- **MASE（多智能体自我演化，Multi-Agent Self-Evolving）**。最后，MASE 引入一个终身、自我演化的闭环，其中智能体群体基于环境反馈与元奖励（meta-rewards）持续优化其提示词、记忆、工具使用策略乃至交互模式（Novikov et al., 2025; Zhang et al., 2025i）。

从 MOP 到 MASE 的演化代表了基于 LLM 的系统开发中的根本性转变：从静态、人工配置的架构，转向能够响应不断变化的需求与环境的自适应、数据驱动系统。自我演化 AI 智能体将基础模型的静态能力与终身智能体系统所需的持续适应性连接起来，为通往更自主、更具韧性、更可持续的 AI 提供了路径。

| 范式（Paradigm） | 交互与反馈（Interaction & Feedback） | 关键技术（Key Techniques） | 示意图（Diagram） |
|---|---|---|---|
| 模型离线预训练（MOP） | 模型 ⇔ 静态数据（损失/反向传播） | Transformer 预训练（因果语言模型、掩码语言模型、NSP）；BPE / SentencePiece；MoE 与流水线并行 | 静态数据 → 模型 → 损失 |
| 模型在线适应（MOA） | 模型 ⇔ 监督信号（标签/评分/奖励） | 任务微调；指令微调；LoRA / 适配器 / 前缀微调；RLHF（RLAIF、DPO、PPO）；多模态对齐；人类对齐 | 模型 A（SFT）→ 模型 B（LoRA）→ 模型 C（RLHF） |
| 多智能体编排（MAO） | 智能体 1 ⇔ 智能体 2（消息交换） | 多智能体系统；自我反思；多智能体辩论；思维链集成；函数/工具调用 / MCP | 智能体 ↔ 智能体 ↔ 智能体 |
| 多智能体自我演化（MASE） | 智能体 ⇔ 环境（来自环境的信号） | 行为优化；提示词优化；记忆优化；工具优化；智能体工作流优化 | 环境 ↔ 智能体 ↔ 智能体 |

**表 1（Table 1）** 四种以 LLM 为中心的学习范式对比——模型离线预训练（MOP）、模型在线适应（MOA）、多智能体编排（MAO）与多智能体自我演化（MASE），突出各范式的交互与反馈机制、核心技术，并通过示意图展示从静态模型训练到动态、自主智能体演化的演进过程。

尽管自我演化 AI 智能体代表了未来 AI 系统的宏大愿景，但要实现这一水平的自主性仍是一个长期目标。当前系统距离安全、稳健、开放式自我演化所需的全部能力仍有很大差距。在实践中，当前向这一愿景的进展是通过智能体演化与优化技术实现的，这些技术为智能体系统提供了切实的手段，使其能够基于交互数据与环境反馈迭代优化自身组件，从而提升其在现实任务中的有效性。近期研究已在若干关键方向展开探索。一条工作主线聚焦于增强底层 LLM 本身，以提升规划（Qiao et al., 2024）、推理（Zelikman et al., 2022; Tong et al., 2024）与工具使用（Feng et al., 2025a）等核心能力。另一条研究主线针对智能体系统内部辅助组件的优化，包括提示词（Xu et al., 2022; Prasad et al., 2023; Yang et al., 2024a; Wang et al., 2025i）、工具（Yuan et al., 2025b; Qu et al., 2025）、记忆（Zhong et al., 2024; Lee et al., 2024d）等，从而使智能体能够更好地泛化到新任务与动态环境。此外，在多智能体系统中，近期工作考察了智能体拓扑与通信协议的优化（Bo et al., 2024; Chen et al., 2025h; Zhang et al., 2025j; Zhou et al., 2025a），旨在找出最适合当前任务的智能体结构，并改进智能体间的协调与信息共享。

现有关于 AI 智能体的综述要么聚焦于智能体架构与功能的一般性介绍（Wang et al., 2024c; Guo et al., 2024c; Xi et al., 2025; Luo et al., 2025a; Liu et al., 2025a,d），要么针对特定组件，如规划（Huang et al., 2024b）、记忆（Zhang et al., 2024d）、协作机制（Tran et al., 2025）与评估（Yehudai et al., 2025）。其他综述则考察智能体的领域特定应用，如操作系统智能体（Hu et al., 2025b）与医疗保健智能体（Sulis et al., 2023）。尽管这些综述对智能体系统的各个方面提供了有价值的见解，但近期在智能体自我演化与持续适应方面的进展尚未得到充分覆盖——而这一能力正是开发终身、自主 AI 系统的核心。这为寻求整体理解支撑自适性与自我演化智能体系统的新学习范式的研究人员与实践者留下了关键的文献空白。

为填补这一空白，本综述对使智能体能够基于交互数据与环境反馈演化并改进自身的技术进行了聚焦而系统的回顾。具体而言，我们引入一个统一概念框架，抽象出自我演化智能体系统设计背后的反馈回路。该框架识别出四个核心组件：系统输入（System Inputs）、智能体系统（Agent System）、环境（Environment）与优化器（Optimisers），凸显智能体系统的演化回路。在此框架基础上，我们系统考察了针对智能体系统不同组件（包括 LLM、提示词、记忆、工具、工作流拓扑与通信机制）的大量演化与优化技术。此外，我们还考察了为专门领域开发的领域特定演化策略。另外，我们专门讨论了自我演化智能体系统的评估、安全与伦理考量，它们对确保系统的有效性与可靠性至关重要。作为一项同期工作，Gao 等人（2025b）围绕三个基础维度——演化什么（what to evolve）、何时演化（when to evolve）与如何演化（how to evolve）——对自我演化智能体进行了综述。尽管其分类法提供了有价值的见解，但本综述旨在提供更全面、更具整合性的视角，即统一概念框架，以审视构建终身、自我演化智能体系统所涉及的机制与挑战。

本综述旨在对自我演化智能体系统的现有技术进行全面而系统的回顾，从而为研究人员与实践者开发更有效、更可持续的智能体系统提供有价值的见解与指导。图 2 展示了现有智能体演化策略的可视化分类体系，涵盖单智能体、多智能体与领域特定优化，并突出各方向的代表性方法。我们的主要贡献如下：

- 我们形式化了自我演化 AI 智能体三定律（Three Laws of Self-Evolving AI Agents），并描绘了以 LLM 为中心的学习范式从静态预训练到完全自主、终身自我演化智能体系统的演化历程。
- 我们引入了一个统一概念框架，抽象出自我演化智能体系统背后的反馈回路，为系统性地理解与比较不同的演化与优化方法提供了基础。
- 我们对单智能体、多智能体与领域特定场景下的现有演化与优化技术进行了系统回顾。
- 我们对自我演化智能体系统的评估、安全与伦理考量进行了全面梳理，强调它们在确保系统有效性、安全性与负责任部署方面的关键作用。
- 我们识别了智能体自我演化中的关键开放挑战，并勾勒了有前景的研究方向，旨在促进未来探索，推动更具适应性、自主性与自我演化能力的智能体系统的发展。

**图 2（Figure 2）** AI 智能体演化与优化技术的可视化分类体系，分为三大方向：单智能体优化、多智能体优化与领域特定优化。树状结构展示了这些方法从 2023 年到 2025 年的发展脉络，并给出每个分支中的代表性方法。

本综述的其余部分组织如下。第 2 节介绍 AI 智能体与多智能体系统的预备知识，包括其定义、关键组件、代表性架构，以及自主与自我演化智能体系统的更广阔愿景。第 3 节介绍智能体演化方法的统一概念框架，概述系统输入、演化目标、智能体结构与优化器等关键要素。第 4 节聚焦单智能体系统的优化，讨论推理策略优化、提示词构造、记忆机制与工具使用等若干关键方面。第 5 节聚焦多智能体系统，回顾优化智能体工作流、拓扑与智能体间通信策略的方法。第 6 节重点介绍领域特定的智能体优化技术及其应用，第 7 节讨论评估智能体系统的评估方法与基准。第 8 节阐述智能体演化与优化领域现有的挑战，并勾勒一些有前景的未来研究方向。最后，我们在第 9 节对综述进行总结。

## 2 AI 智能体系统基础（Foundation of AI Agent Systems）

为便于清晰理解智能体的进化与优化，本节概述现有 AI 智能体系统。我们首先在 2.1 节介绍单智能体系统（single-agent system），概述其定义与核心组件；随后在 2.2 节转向多智能体系统（multi-agent system, MAS），阐述其动机、结构范式与协作机制；最后在 2.3 节呈现终身自进化智能体系统（lifelong, self-evolving agentic system）的愿景。

### 2.1 AI 智能体（AI Agents）

AI 智能体（AI agent）指能够感知输入、对目标进行推理并与环境交互以完成任务的自主系统（Luo et al., 2025a）。本节聚焦作为 AI 智能体研究基础的单智能体系统。虽然我们在此仅提供简要概述，读者可参阅现有综述，以获取关于 AI 智能体架构与能力的更全面讨论（Guo et al., 2024c; Xi et al., 2025; Luo et al., 2025a; Liu et al., 2025a）。

AI 智能体通常由多个协同工作的组件构成，以实现自主决策与执行。智能体的核心组件是基础模型（Foundation Model），最常见的是大语言模型（large language model, LLM）²，它作为中心推理引擎，负责解释指令、生成计划并产出可执行的响应。此外，还有一些支撑模块用于增强智能体在复杂动态环境中的能力：

（1）感知模块（Perception Module）。感知模块负责从环境中获取并解释信息（Li et al., 2024f），包括处理文本输入、音频信号、视频帧或其他类感觉（sensory-like）数据，以构建适合推理的表征。

（2）规划模块（Planning Module）。规划模块使智能体能够将复杂任务分解为可执行的子任务或操作序列，并引导其跨多个步骤执行（Huang et al., 2024b）。这一过程促进分层推理（hierarchical reasoning），并确保任务连贯完成。规划最简单的形式之一是线性任务分解（linear task decomposition），即将问题拆解为多个中间步骤，由 LLM 依序求解，典型方法如思维链提示（chain-of-thought prompting）（Wei et al., 2022）。在静态规划之外，更动态的方法以迭代循环的方式将规划与执行交织进行。例如，ReAct 框架（Yao et al., 2023b）将推理与行动相结合，使智能体能够根据实时反馈修订计划。除线性规划外，一些方法采用分支策略（branching strategy），即每一步都可能衍生出多个可能的后续路径，代表性例子是思维树（Tree-of-Thought）（Yao et al., 2023a）与思维图（Graph-of-Thought）（Besta et al., 2024），它们使智能体能够探索多条推理路径。

（3）记忆模块（Memory Module）。记忆模块使智能体能够保留并回忆过往经验，从而实现上下文感知的推理与长期一致性。广义上，记忆可分为短期记忆（short-term memory）与长期记忆（long-term memory）。短期记忆通常存储当前任务执行过程中产生的上下文与交互；任务完成后，短期记忆即被清除。相比之下，长期记忆随时间持续存在，可存储跨任务累积的知识、过往经验或可复用信息。为访问相关的长期记忆，许多智能体系统采用检索增强生成（retrieval-augmented generation, RAG）模块（Zhang et al., 2024d），智能体从中检索相关信息并将其融入 LLM 的输入上下文。设计有效的记忆模块涉及若干挑战，包括如何组织记忆表征、何时存储及存储什么、如何高效检索相关信息，以及如何将其整合进推理过程（Zeng et al., 2024a）。关于 AI 智能体记忆机制的更全面综述，我们推荐读者参阅 Zhang et al.（2024d）的综述。

（4）工具使用（Tool Use）。使用外部工具的能力是 AI 智能体在真实世界场景中有效运作的关键因素。尽管 LLM 在语言理解与生成方面能力强大，但其能力本质上受限于静态知识与推理能力。通过使用外部工具，智能体可以扩展其功能范围，从而更好地与真实世界环境交互。典型工具包括网络搜索引擎（Li et al., 2025g）、代码解释器或执行环境（Islam et al., 2024），以及浏览器自动化框架（Müller and Žunič, 2024）。工具使用组件的设计通常涉及工具选择、构造工具特定的输入、调用 API，以及将工具输出整合回推理过程。

> ² 虽然本综述聚焦于大语言模型，但骨干模型（backbone）可以是任何基础模型（例如视觉-语言模型、蛋白质序列/结构模型），我们所讨论的核心智能体原则可轻易推广至此类骨干模型。

### 2.2 多智能体系统（Multi-Agent Systems）

虽然单智能体系统已在各类任务中展现出强大能力，但许多现实任务所需的专业化与协调已超出单个智能体的能力范围。这一局限催生了多智能体系统（multi-agent system, MAS）的发展，它模拟了生物与社会系统中的分布式智能。

MAS 的形式化定义是：在共享环境中交互、以实现超出单个智能体能力目标的一组自主智能体。与仅依赖个体推理与能力的单智能体系统不同，MAS 侧重于通过不同智能体之间的结构化协调与协作实现集体智能（Tran et al., 2025）。支撑这种协调的基本机制是智能体拓扑（agent topology）概念，即定义系统内智能体如何连接与通信的结构配置。拓扑决定了智能体间的信息流与协作策略，直接影响任务的分配与执行方式。因此，MAS 通常以多智能体工作流（multi-agent workflow）的形式实现，由系统拓扑编排各智能体间的交互，以完成复杂的共同目标。关键洞察在于：当多个智能体通过此类工作流协作时，系统的整体性能可以超过系统内所有智能体个体能力之和（Lin et al., 2025; Luo et al., 2025a）。

与单智能体系统相比，MAS 带来了若干显著优势。第一，MAS 可将复杂任务分解为可管理的子任务并分配给专业化的智能体，这有助于提升整体性能（Krishnan, 2025; Sarkar and Sarkar, 2025）。这种方式模仿了人类组织协作，使 MAS 能够处理超出单个智能体能力的任务。第二，MAS 支持并行执行，允许多个智能体同时工作以完成任务。该特性对时间敏感的应用尤为有利，可大幅加速问题求解过程（Zhang et al., 2025k; Liu et al., 2025a; Li et al., 2025h）。第三，MAS 的去中心化特性增强了鲁棒性：当某个智能体失效时，其他智能体可以动态地重新分配任务并补偿故障，从而实现优雅降级（graceful degradation）而非系统整体崩溃（Huang et al., 2024a; Yang et al., 2025b）。第四，MAS 具有固有的可扩展性，新智能体可无缝集成而无需重新设计整个系统（Han et al., 2024; Chen et al., 2025g）。最后，辩论（debate）与迭代精炼（iterative refinement）等协作机制使 MAS 能够借助多样化的视角与智能体间的批判性评估，生成更具创新性与可靠性的解决方案（Guo et al., 2024c; Lin et al., 2025）。CAMEL 与 AutoGen 等框架通过提供模块化架构、角色扮演模式与自动化编排能力，进一步简化了 MAS 的开发，降低了工程开销（Li et al., 2023a; Wu et al., 2024a）。

#### 2.2.1 系统架构（System Architecture）

MAS 的架构设计从根本上决定了智能体如何组织、协调与执行任务。这些结构从严格的层级结构到灵活的对等（peer-to-peer）网络各不相同，各自体现了关于控制、自主性与协作的不同理念。

（1）层级结构（Hierarchical Structure）。此类系统采用静态层级组织，通常是线性的或基于树的，任务被显式分解并按序分配给特定智能体。例如，MetaGPT（Hong et al., 2024）引入标准作业程序（Standard Operating Procedures, SOPs）来精简软件开发流程，而 HALO（Hou et al., 2025）整合蒙特卡洛树搜索（Monte Carlo Tree Search, MCTS）以增强推理性能。这种高度定制化的方法提供了模块化、开发简便性与领域特定优化等优势，在软件开发、医学、科学研究与社会科学领域广泛采用（Zheng et al., 2023b; Park et al., 2023; Qian et al., 2024; Li et al., 2024c; Cheng et al., 2025）。

（2）集中式结构（Centralised Structure）。该架构遵循管理者-执行者（manager-follower）范式：一个中心智能体或更高级别的协调者负责规划、任务分解与委派，下属智能体则执行分配到的子任务。这种设计有效地在全局规划与具体任务执行之间取得平衡（Fourney et al., 2024; Roucher et al., 2025; CAMEL-AI, 2025）。然而，中心节点会造成性能瓶颈，并引入单点故障（single-point-of-failure）风险，削弱系统鲁棒性（Ko et al., 2025）。

（3）去中心化结构（Decentralised Structure）。在该架构中，智能体作为分布式网络中的对等节点协作，广泛应用于世界模拟（world simulation）应用。由于缺乏集中控制，可避免单点故障——任一节点的损坏都不会使整个系统瘫痪，从而消除瓶颈并增强鲁棒性（Lu et al., 2024b; Yang et al., 2025b）。然而，这也带来了信息同步、数据安全以及协作成本增加等挑战（Ko et al., 2025）。近期工作探索利用区块链技术应对这些协调挑战（Geren et al., 2024; Yang et al., 2025d）。

#### 2.2.2 通信机制（Communication Mechanisms）

MAS 的有效性在很大程度上取决于智能体如何交换信息与协调行动。MAS 中的通信方法已从简单的消息传递演进到能够平衡表达力、效率与互操作性的复杂协议。

（1）结构化输出（Structured Output）。该方法采用 JSON（Li et al., 2024e; Chen et al., 2025g）、XML（Zhang et al., 2025b; Kong et al., 2025）与可执行代码（Roucher et al., 2025）等格式进行智能体间通信。显式的结构与明确定义的参数保证了高度的机器可读性与可解释性，标准化格式则便于跨平台协作（Chen et al., 2025g）。这些特性使结构化通信非常适合追求精确与高效的应用，如问题求解与推理任务。紧凑的信息表征进一步提升了计算效率（Wang et al., 2024h）。

（2）自然语言（Natural Language）。自然语言通信保留了丰富的上下文与语义细节，特别适合创意任务、世界模拟与创意写作等场景（Liu et al., 2025a）。这种表达力支持精细的交互，能够捕捉微妙的意义与意图。然而，它也带来了歧义、潜在误解以及与结构化格式相比执行效率降低等挑战（Guo et al., 2024c; Yang et al., 2025c; Kong et al., 2025）。

（3）标准化协议（Standardised Protocols）。近期进展引入了旨在标准化 MAS 通信的专用协议，构建了更具包容性与互操作性的智能体生态系统：A2A（LLC and Contributors）通过结构化、对等的任务委派模型标准化智能体间的水平通信，使智能体能够在保持执行不透明性（execution opacity）的同时协作处理复杂、长时运行的任务。ANP（Chang and Contributors）通过内置去中心化身份（Decentralised Identity, DID）与动态协议协商的层级架构，为去中心化的"智能体互联网"（agent internet）实现安全、开放的水平通信。MCP（PBC and Contributors）通过统一的客户端-服务器接口，标准化单个智能体与外部工具或数据资源之间的垂直通信。Agora（Marro and Contributors）作为水平通信的元协议（meta-protocol），使智能体能够动态协商并进化其通信方式，在灵活的自然语言与高效的结构化例程之间无缝切换。

### 2.3 终身自进化智能体系统的愿景（The Vision of Lifelong, Self-Evolving Agentic Systems）

从模型离线预训练（Model Offline Pretraining, MOP），经模型在线适配（Model Online Adaptation, MOA）到多智能体编排（Multi-Agent Orchestration, MAO），这一演进轨迹持续降低了基于 LLM 的系统中人工配置的程度。然而，即使是当今最先进的多智能体框架，往往仍依赖手工设计的工作流、固定的通信协议与人工策划的工具链（Talebirad and Nadiri, 2023; Zhao et al., 2024; Luo et al., 2025a; Tran et al., 2025）。这些静态要素制约了适应性，使智能体难以在需求、资源与目标随时间演化的动态开放式环境中持续保持性能。

新兴的多智能体自进化（Multi-Agent Self-Evolving, MASE）系统范式通过在部署与持续改进之间闭合循环来应对这些局限。在 MASE 系统中，一个智能体种群被赋予自主精炼其提示、记忆、工具使用策略乃至交互拓扑的能力——以环境反馈与更高层次的元奖励（meta-rewards）为引导（Novikov et al., 2025; Zhang et al., 2025i）。这一持续优化过程使智能体不仅能一次性适应，还能在其整个生命周期中随着任务、领域与运行约束的变化而不断进化。

终身自进化智能体系统旨在通过将持续改进循环嵌入架构核心来克服这些约束。在自进化 AI 智能体三定律（Three Laws of Self-Evolving AI Agents）——持久（Endure，安全适配）、卓越（Excel，性能保持）与进化（Evolve，自主优化）——的指导下，此类系统被设计为：

（I）在运行期间监控自身的性能与安全状况；

（II）通过受控的增量更新保持或增强能力；

（III）针对变化的任务、环境与资源，自主适配提示、记忆结构、工具使用策略乃至智能体间拓扑。

终身自进化系统无需人类设计者手工构建每一种交互模式，而是能够生成、评估并精炼自身的智能体配置，在环境反馈、元级推理与结构适配之间闭合循环。这使智能体从静态执行者转变为在其运行生态系统中持续学习、共同进化的参与者。

这一愿景具有深远影响。在科学发现领域，自进化智能体生态系统可以自主生成假设、设计实验并迭代研究流程；在软件工程领域，它们可以与开发流水线共同进化，在新工具出现时加以整合；在人机协作领域，它们可以学习个体偏好并持续个性化交互风格。超越数字领域，此类系统还可通过机器人、物联网（IoT）设备与信息物理基础设施与物理世界交互，感知环境变化并对其采取行动，将真实世界的反馈纳入其进化循环。通过将智能体视为可重构、能够自我进化、协调与长期适应的计算实体，MASE 为实现可扩展、可持续且可信赖的 AI 提供了一条路径——一种不仅经过一次性训练，而且会生存（lives）、学习（learns）并长存（lasts）的 AI。

## 3 MASE 概念框架（A Conceptual Framework of MASE）

为提供自进化智能体系统的全面概述，我们提出一个高层概念框架，对智能体进化与优化方法设计与实现背后的关键要素进行抽象与总结。该框架为大多数现有优化方法提供了一种抽象而可泛化的视角，从而促进对该领域的全面理解，并便于跨方法的比较分析。

### 3.1 自进化过程概述（Overview of the Self-Evolving Process）

我们首先概述智能体系统中的自进化过程，该过程在实践中通常通过迭代优化来实现。在此过程中，智能体系统基于从性能评估与环境交互中获得的反馈信号进行迭代更新。如图 3 所示，该过程始于任务规范（task specification），其中可能包含高层描述、输入数据、上下文信息或具体示例。这些要素构成系统输入（system inputs），它们定义了智能体系统所处的问题设定。随后，遵循单智能体或多智能体架构的智能体系统（agent system）被部署到环境中执行任务。环境提供运行上下文并生成反馈信号，这些信号源自预定义的评估指标，用于衡量系统的有效性并指导后续优化。基于环境反馈，优化器（optimiser）应用特定算法与策略更新智能体系统，例如调整 LLM 参数、修改提示或精炼系统结构。在某些情况下，优化器还可能通过合成训练示例来精炼系统输入，以扩充现有数据集，从而扩大后续优化循环可用的数据。更新后的智能体系统随后被重新部署到环境中，启动下一轮迭代。该过程形成一个迭代的闭合反馈循环，智能体系统在多次迭代中被逐步精炼与优化。循环在达到预定义性能阈值或满足收敛条件时终止。基于 MASE 概念框架，EvoAgentX 是首个应用这一自进化智能体过程的开源框架，旨在自动化智能体系统的生成、执行、评估与优化（Wang et al., 2025i）。

**图 3** 智能体系统中自进化过程的概念框架。该过程构成一个迭代优化循环，包含四个组件：系统输入（System Inputs）、智能体系统（Agent System）、环境（Environment）与优化器（Optimiser）。系统输入定义任务设定（例如任务级或实例级）；智能体系统（以单智能体或多智能体形式）执行指定任务；环境（视不同场景而定）通过代理指标（proxy metrics）提供反馈；优化器通过定义的搜索空间与优化算法更新智能体系统，直至达到性能目标。

图中各组件（图示标签）：设置（Setup）/ 变异-精炼（Mutation–Refine）/ 环境场景（Environment Scenarios）/ 反馈（Feedback）/ 系统输入（System Inputs）：任务级（Task-level）、实例级（Instance-level）/ 智能体系统（Agent System）：单智能体（Single-agent）、多智能体（Multi-agent）：提示（Prompt）、工具（Tools）、记忆（Memory）、智能体（Agents）、通信（Communication）、拓扑（Topology）/ 优化器（Optimiser）：搜索空间（Search Space）：提示模板（Prompt Template）、工具选择（Tool Selection）、LLM 参数（LLM Parameters）、架构（Architectural）；优化算法（Optimisation Algorithm）：规则式启发（Rule-base Heuristics）、梯度下降（Gradient Descent）、贝叶斯与 MCTS 与强化学习（Bayesian & MCTS & RL）、基于学习的策略（Learning-based Policy）；代理指标（Proxy Metrics）：准确率、F1（Accuracy, F1）、成功率（Success rate）；基于 LLM 的评估器（LLM-based Evaluators）；编码、法律、科研、医学（Coding、Legal、Research、Medicine）/ 执行（Execution）

基于上述概述，智能体优化过程包含四个关键组件：系统输入、智能体系统、环境与优化器。下面我们对每个组件进行介绍，强调它们在优化框架中的各自作用、特性与交互。

### 3.2 系统输入（System Inputs）

系统输入指提供给优化过程的上下文信息与数据。形式上，我们将系统输入集合记为 $I$，它由一个或多个元素组成，用于指明任务需求、约束与可用数据。这些输入定义了智能体系统所处的问题设定，并决定了优化的范围。根据场景的不同，$I$ 可以取不同形式：

- **任务级优化（Task-Level Optimisation）**。现有研究中最常见的设定是提升智能体系统在特定任务上的整体性能。此时，系统输入 $I$ 可包括任务描述 $T$ 与用于训练或验证的训练数据集 $D_{\text{train}}$：$I = \{T, D_{\text{train}}\}$。还可以加入独立的测试数据集 $D_{\text{test}}$，以评估优化后智能体的性能。在某些场景中，任务特定的标注数据（即 $D_{\text{train}}$）不可用。为在此类设定下实现优化，近期方法（Huang et al., 2025; Zhao et al., 2025a; Liu et al., 2025b）提出动态合成训练示例（通常通过基于 LLM 的数据生成），以创建用于迭代改进的替代数据集。

- **实例级优化（Instance-Level Optimisation）**。近期研究还探索了一种更细粒度的设定，其目标是提升智能体系统在某个特定示例上的性能（Sun et al., 2024a; Novikov et al., 2025）。此时，系统输入可包含一个输入-输出对 $(x, y)$，以及可选的上下文信息 $C$，即 $I = \{x, y, C\}$。

### 3.3 智能体系统（Agent Systems）

智能体系统是反馈循环中接受优化的核心组件。它定义了智能体针对给定输入做出决策的过程与功能。形式上，我们将智能体系统记为 $A$，它可由单个智能体或一组协作智能体组成。智能体系统 $A$ 可进一步分解为若干组件，如底层 LLM、提示策略、记忆模块、工具使用策略等。根据目标范围的不同，优化方法可聚焦于这些组件中的一个或多个。在大多数现有工作中，优化针对 $A$ 的单个组件进行，例如微调 LLM 以增强推理与规划能力（Zelikman et al., 2022; Tong et al., 2024; Lai et al., 2024b），或在不修改 LLM 本身的情况下调整提示与选择合适工具，以提升任务特定性能（Yang et al., 2024a; Yuan et al., 2025b）。此外，近期研究也探索了对 $A$ 内多个组件的联合优化。例如，在单智能体系统中，一些方法联合优化 LLM 与提示策略，以更好地使模型行为与任务要求对齐（Soylu et al., 2024）；在多智能体系统中，现有研究探索了提示与智能体间拓扑的联合优化，以提升整体有效性（Zhang et al., 2025j; Zhou et al., 2025a）。

### 3.4 环境（Environments）

环境是智能体系统运行并产生输出的外部情境。具体而言，智能体系统通过感知输入、执行动作并接收相应结果与环境交互。根据任务的不同，环境可以从基准数据集到完全动态的真实世界设定不等（Liu et al., 2023a）。例如，在代码生成任务中，环境可包括编译器、解释器与测试用例等代码执行与验证组件；在科学研究中，它可由文献数据库、仿真平台或实验室设备组成。

除提供运行情境外，环境在生成反馈信号方面也扮演关键角色，这些信号为优化过程提供信息与引导。此类信号通常源自评估指标（evaluation metrics），用于量化智能体系统的有效性或效率。在大多数情况下，此类指标是任务特定的，如准确率（accuracy）、F1 或成功率（success rate），它们提供性能的定量度量。然而，在缺乏标注数据或真实值（ground-truth）的设定下，通常采用基于 LLM 的评估器（LLM-based evaluators）来估计性能（Yehudai et al., 2025）。这些评估器可生成代理指标（proxy metrics），或通过评估正确性、相关性、连贯性以及与任务指令的对齐程度等维度提供文本反馈。关于不同应用中评估策略的更详细讨论见第 7 节。

### 3.5 优化器（Optimisers）

优化器（$P$）是自进化反馈循环的核心组件，负责基于环境反馈精炼智能体系统 $A$。其目标是通过专门算法与策略，在给定评估指标下搜索性能最优的智能体配置。形式上，可表示为：

$$A^{*} = \arg\max_{A \in \mathcal{S}} O(A; I), \tag{1}$$

其中 $\mathcal{S}$ 表示配置的搜索空间（search space），$O(A; I) \in \mathbb{R}$ 是评估函数，将 $A$ 在给定系统输入 $I$ 上的性能映射为标量分数，$A^{*}$ 表示最优智能体配置。

优化器通常由两个核心组件定义：（1）**搜索空间（$\mathcal{S}$）**：定义可被探索与优化的智能体配置集合。$\mathcal{S}$ 的粒度取决于智能体系统中被优化的部分，范围从智能体提示或工具选择策略，到连续的 LLM 参数或架构结构。（2）**优化算法（$\mathcal{H}$）**：指定用于探索 $\mathcal{S}$ 并选择或生成候选配置的策略，可包括基于规则的启发式（rule-based heuristics）、梯度下降（gradient descent）、贝叶斯优化（Bayesian optimisation）、蒙特卡洛树搜索（Monte Carlo Tree Search, MCTS）、强化学习（reinforcement learning）、进化策略（evolutionary strategies）或基于学习的策略（learning-based policies）。二者构成的 $(\mathcal{S}, \mathcal{H})$ 对定义了优化器的行为，并决定其能否高效、有效地引导智能体系统趋向更优性能。

在后续章节中，我们介绍三种不同设定下的典型优化器：单智能体系统（第 4 节）、多智能体系统（第 5 节）与领域特定智能体系统（第 6 节）。每种设定都表现出不同的特点与挑战，从而产生不同的优化器设计与实现。在单智能体优化中，重点是调优 LLM 参数、提示、记忆机制或工具使用策略，以提升单个智能体的性能。相比之下，多智能体优化将范围扩展到不仅优化单个智能体，还优化其结构设计、通信协议与协作能力。领域特定智能体优化则带来额外挑战，优化器必须考虑特定领域固有的专门要求与约束，从而产生定制化的优化器设计。图 5 提供了这些优化设定及其代表性方法的全面分层分类（hierarchical categorisation）。

## 4 单智能体优化（Single-Agent Optimisation）

**图 4** 单智能体优化方法概览，按智能体系统内的目标组件（提示、记忆与工具）进行分类。

```
单智能体
├── 记忆
├── 工具
├── 大语言模型
├── 提示
└── 大语言模型行为优化
    ├── 推理行为优化
    └── 测试时扩展优化
        ├── 基于反馈的策略
        └── 基于搜索的策略
```

**提示优化（Prompt Optimisation）**
- 基于编辑的优化（Edit-Based Optimisation）
- 生成式优化（Generative Optimisation）
- 基于文本梯度的优化（Text Gradient-Based Optimisation）
- 进化式优化（Evolutionary Optimisation）

**记忆优化（Memory Optimisation）**
- 短期记忆优化（Short-term Memory Optimisation）
- 长期记忆优化（Long-term Memory Optimisation）

**工具优化（Tool Optimisation）**
- 基于训练的优化（Training-Based Optimisation）
- 推理时优化（Inference-Time Optimisation）
- 基于提示的工具优化（Prompt-Based Tool Optimisation）
- 基于推理的工具优化（Reasoning-Based Tool Optimisation）

单智能体优化聚焦于提升单智能体系统的性能。根据前文引入的优化反馈回路，其关键挑战在于设计用于更新系统的优化器。这涉及识别智能体系统中待优化的具体组件（即搜索空间）、确定需要增强的特定能力，以及选择恰当的优化策略以有效实现这些改进（即优化算法）。

在本节中，我们根据智能体系统中的目标组件来组织单智能体优化方法，因为这同时决定了搜索空间的结构与优化方法的选择。具体而言，我们聚焦四大类方法：（1）大语言模型行为优化，旨在通过参数调优或测试时扩展（test-time scaling）技术来提升大语言模型的推理与规划能力；（2）提示优化，聚焦于调整提示，引导大语言模型产生更准确、更贴合任务的输出；（3）记忆优化，旨在增强智能体存储、检索并对历史信息或外部知识进行推理的能力；（4）工具优化，聚焦于增强智能体有效利用现有工具、或自主创建与配置新工具以完成复杂任务的能力。图 4 展示了单智能体优化方法的主要类别。

**图 5** Agentic 自进化（Agentic Self-Evolution）方法的综合层次化分类，涵盖单智能体、多智能体及领域专用优化类别，并列举了各方法的代表性工作。

| 类别 | 子类别 | 代表性工作 |
|---|---|---|
| 单智能体优化 | 行为优化——SFT | STaR (Zelikman et al., 2022)；ToRA (Gou et al., 2024)；NExT (Ni et al., 2024) |
| | 行为优化——RL | Self-Rewarding (Yuan et al., 2024d)；DeepSeek-Prover-v1.5 (Xin et al., 2025)；Absolute-Zero (Zhao et al., 2025a) |
| | 行为优化——验证器模块 | Baldur (First et al., 2023)；Math-Shepherd (Wang et al., 2024d)；Rewarding Progress (Setlur et al., 2025) |
| | 行为优化——基于搜索 | CoT-SC (Wang et al., 2023b)；Tree-of-Thoughts (Yao et al., 2023a)；Graph-of-Thoughts (Besta et al., 2024) |
| | 提示优化——基于编辑 | GPS (Xu et al., 2022)；GrIPS (Prasad et al., 2023)；TEMPERA (Zhang et al., 2023b) |
| | 提示优化——基于生成 | APE (Zhou et al., 2023c)；PromptAgent (Wang et al., 2024i)；OPRO (Yang et al., 2024a)；APOHF (Lin et al., 2024a)；RETROFORMER (Yao et al., 2024)；MIPRO (Opsahl-Ong et al., 2024)；StraGo (Wu et al., 2024b)；SPO (Xiang et al., 2025) |
| | 提示优化——基于文本梯度 | ProTeGi (Pryzant et al., 2023)；TextGrad (Yuksekgonul et al., 2024) |
| | 提示优化——基于进化 | EvoPrompt (Guo et al., 2024b)；Promptbreeder (Fernando et al., 2024) |
| | 记忆优化——短期记忆 | COMEDY (Chen et al., 2025f)；ReadAgent (Lee et al., 2024d)；MoT (Li and Qiu, 2023)；StructRAG (Li et al., 2025i)；MemoryBank (Zhong et al., 2024) |
| | 记忆优化——长期记忆 | EWE (Chen et al., 2025d)；A-MEM (Xu et al., 2025)；Mem0 (Chhikara et al., 2025)；GraphReader (Li et al., 2024d)；AWM (Wang et al., 2024l)；MyAgent (Hou et al., 2024) |
| | 工具优化——基于训练 | ToolLLM (Qin et al., 2024)；Confucius (Gao et al., 2024a)；Re-Tool (Feng et al., 2025a)；ToolRL (Qian et al., 2025a)；SWiRL (Goldie et al., 2025)；Nemotron-Research-Tool-N1 (Zhang et al., 2025m) |
| | 工具优化——基于提示 | EASYTOOL (Yuan et al., 2025b)；PLAY2PROMPT (Fang et al., 2025)；DRAFT (Qu et al., 2025)；JointOptim (Wu et al., 2025a) |
| | 工具优化——工具创建 | CREATOR (Qian et al., 2023)；LATM (Cai et al., 2024)；CRAFT (Yuan et al., 2024a)；AgentOptimizer (Zhang et al., 2024b)；Alita (Qiu et al., 2025) |
| 多智能体优化 | 提示优化 | AutoAgents (Chen et al., 2024b)；DSPy (Singhvi et al., 2023)；MIPRO (Opsahl-Ong et al., 2024)；PromptWizard (Agarwal et al., 2024) |
| | 拓扑优化——代码级工作流 | AutoFlow (Li et al., 2024h)；AFlow (Zhang et al., 2025j)；ScoreFlow (Wang et al., 2025j)；MAS-GPT (Ye et al., 2025) |
| | 拓扑优化——通信图 | GPTSwarm (Zhuge et al., 2024a)；DynaSwarm (Leong and Wu, 2025)；G-Designer (Zhang et al., 2024a)；NetSafe (Yu et al., 2024a)；AgentPrune (Zhang et al., 2025g)；AGP (Li et al., 2025a) |
| | 统一优化——基于代码 | ADAS (Hu et al., 2025a)；FlowReasoner (Gao et al., 2025a) |
| | 统一优化——基于搜索 | EvoAgent (Yuan et al., 2025a)；MASS (Zhou et al., 2025a)；DebFlow (Su et al., 2025)；EvoFlow (Gao et al., 2025a)；MAS-ZERO (Ke et al., 2025) |
| | 统一优化——基于学习 | MaAS (Zhang et al., 2025f)；ANN (Ma et al., 2025) |
| | 大语言模型主干优化——面向推理 | AutoFlow (Li et al., 2024h)；AFlow (Zhang et al., 2025j)；ScoreFlow (Wang et al., 2025j)；MAS-GPT (Ye et al., 2025) |
| | 大语言模型主干优化——面向协作 | COPPER (Bo et al., 2024)；OPTIMA (Chen et al., 2025h)；MaPoRL (Park et al., 2025) |
| 领域专用优化 | 生物医学——医学诊断 | MedAgentSim (Almansoori et al., 2025)；PathFinder (Ghezloo et al., 2025)；MDAgents (Kim et al., 2024)；MDTeamGPT (Chen et al., 2025c)；MMedAgent (Li et al., 2024a)；MedAgent-Pro (Wang et al., 2025l) |
| | 生物医学——分子发现 | CACTUS (McNaughton et al., 2024)；LLM-RDF (M. Bran et al., 2024)；ChemAgent (Tang et al., 2025a)；OSDA Agent (Hu et al., 2025c)；DrugAgent (Inoue et al., 2025)；LIDDIA (Averly et al., 2025) |
| | 编程——代码精炼 | Self-Refine (Madaan et al., 2023)；AgentCoder (Huang et al., 2023a)；CodeAgent (Tang et al., 2024)；CodeCoR (Pan et al., 2025b)；OpenHands (Wang et al., 2025g) |
| | 编程——代码调试 | Self-Debugging (Chen et al., 2024c)；Self-Edit (Zhang et al., 2023a)；PyCapsule (Adnan et al., 2025)；RGD (Jin et al., 2024) |
| | 金融与法律研究——金融决策 | FinCon (Yu et al., 2024b)；PEER (Wang et al., 2024j)；FinRobot (Yang et al., 2024b) |
| | 金融与法律研究——法律推理 | LawLuo (Sun et al., 2024b)；AgentCourt (Chen et al., 2025a)；LegalGPT (Shi et al., 2024b) |

### 4.1 大语言模型行为优化（LLM Behaviour Optimisation）

主干大语言模型（backbone LLM）为单智能体系统奠定基础，是负责规划、推理与任务执行的主要组件。因此，提升大语言模型的规划与推理能力是改善智能体系统整体效能的核心。这一方向上的近期工作大体可分为两类：（1）基于训练的方法，直接更新模型参数以提升推理能力与任务性能；（2）测试时方法，旨在推理阶段改进大语言模型的行为而不修改其参数。下面，我们对这两类方法中的代表性工作加以综述与总结。

#### 4.1.1 基于训练的行为优化（Training-Based Behaviour Optimisation）

尽管大语言模型已展现出强大的语言能力 (Zhao et al., 2023)，近期研究 (Wu et al., 2024c) 却指出了其自然语言流畅性与执行复杂推理能力之间的显著差距。这一差距限制了大语言模型智能体在需要多步推理与复杂决策的任务中的有效性。为应对这一问题，近期工作探索了面向推理的训练方法，利用监督微调（supervised fine-tuning, SFT）与强化学习（reinforcement learning, RL）帮助模型系统地评估并改进其回答。

**监督微调。** 监督微调的核心思想是使用包含详细推理步骤的标注数据来训练智能体，使模型学习从输入问题、经中间推理过程、到最终答案的完整映射。这种方法通常依赖精心构造的推理轨迹，这些轨迹一般可由以下来源构建：（1）智能体在执行过程中自行生成的轨迹（rollouts），以及（2）更强的教师智能体产生的演示。通过模仿这些轨迹，智能体获得了以结构化方式进行逐步推理的能力。STaR (Zelikman et al., 2022) 提出一种迭代微调流程：模型在其已正确求解的实例上进行训练，并对错误的轨迹加以改进以生成更优轨迹。基于这一思想，NExT (Ni et al., 2024) 使用经单元测试正确性筛选的自生成轨迹，使智能体在程序修复任务上自我进化。类似地，Deepseek-Prover (Xin et al., 2024) 通过用已验证的证明迭代训练策略模型，使智能体逐步进化，从而在定理证明任务上生成日益精确的形式化证明。另一条研究路线使用专有大语言模型生成的轨迹对智能体进行微调，覆盖数学 (Gou et al., 2024; Yin et al., 2024) 与科学 (Ma et al., 2024) 等领域。除智能体能力之外，Min et al. (2024)；Huang et al. (2024c)；Labs (2025) 还基于 OpenAI o1 (Jaech et al., 2024) 生成的轨迹训练模型，以复现其思考能力，旨在进一步提升智能体主干的推理能力。

**强化学习。** 强化学习将推理视为一个序列决策过程，模型因产生正确或高质量的推理路径而获得奖励。其中一种策略是基于偏好的优化：利用从各种来源（如测试用例表现、最终结果正确性或训练好的过程奖励模型（process reward model, PRM）产生的伪标签）生成的偏好对来应用 DPO (Rafailov et al., 2023) (Hui et al., 2024; Min et al., 2024; Jiao et al., 2024; Liu et al., 2025f)。Yuan et al. (2024d) 进一步引入一种自进化框架，策略模型利用自身判断迭代地精炼其推理能力。类似地，Agent Q (Putta et al., 2024) 将蒙特卡洛树搜索（MCTS）引导的搜索与自我批评机制相结合，利用成功与失败的轨迹，通过 DPO 在网页环境中迭代改进智能体的决策。在另一条研究路线中，Tülu 3 (Lambert et al., 2024) 在数学与指令遵循任务上应用带可验证奖励的强化学习，无需任何学习的奖励模型。值得注意的是，DeepSeek-R1 (Guo et al., 2025) 进一步证明：当可以进行真值验证时，采用群体相对策略优化（Group Relative Policy Optimisation）(Shao et al., 2024) 的纯强化学习是可行的。沿此方向，Xin et al. (2025) 将该思想扩展至 DeepSeek-Prover 的增强，融入了基于证明助手反馈的强化学习。Liu et al. (2025e) 通过引入 MSTAR 进一步探索多模态设定下的自进化训练，该框架利用强化学习克服性能饱和，并通过迭代式自我改进增强推理能力。超越在固定数据集中使用可验证奖励的范式，Absolute Zero (Zhao et al., 2025a) 训练单一模型交替扮演任务提出者与求解者两种角色，通过生成并求解自身提出的问题实现自我进化。类似地，R-Zero (Huang et al., 2025) 采用双模式框架，由挑战者生成针对求解者当前能力量身定制的任务，使双方在无外部监督的情况下迭代进化。

#### 4.1.2 测试时行为优化（Test-Time Behaviour Optimisation）

随着训练资源日益受限、且基于 API 的模型无法微调，测试时计算成为应对这些限制的解决方案：它使模型能够在推理阶段无需额外训练即可精炼或扩展其推理能力。通过增加推理预算，模型得以"思考更久"。

扩展测试时能力可通过两种主要策略实现。第一种策略通过融入外部反馈来引导推理，从而促进模型对其回答的改进。第二种策略聚焦于利用更高效的采样算法生成多个候选输出，随后通过选择过程由验证器识别出最合适的输出。值得注意的是，这两种方法实际上密切相关：前者用于引导生成的反馈，天然可以作为后者的验证器。

**基于反馈的策略。** 一种自然的方法是根据模型生成输出的质量来调整其行为。这一过程通常依赖来自验证器（verifier）的反馈，验证器提供精确或估计的分数以引导模型。我们将反馈分为两类。结果级反馈（outcome-level feedback）仅根据最终输出提供单一分数或信号，而不论推理步骤的数量。对于真值易于获取的任务，验证器可被实现为外部工具以提供精确反馈。例如，CodeT (Chen et al., 2023) 与 LEVER (Ni et al., 2023) 利用编译器执行生成的代码，并对照测试用例验证其正确性。START (Li et al., 2025c) 与 CoRT (Li et al., 2025b) 采用基于提示的工具调用来增强长思维链（CoT）推理。类似地，Baldur (First et al., 2023) 利用证明助手的错误信息来进一步修复大语言模型生成的不正确证明。然而，对于大多数任务而言，真值在推理时并不总是可得的。因此，更通用的做法是训练一个模型充当验证器，为每个候选回答打分 (Liu et al., 2024a, 2025c)，从而根据预测质量对候选进行排序。不过，这种反馈形式相对稀疏，因为它只评估最终输出。相比之下，步骤级反馈（step-level feedback）评估生成过程中的每一个中间步骤，提供更细粒度的监督。仅依赖结果反馈往往导致不忠实推理（unfaithful reasoning）问题 (Turpin et al., 2023)，即错误的推理链仍可能产生正确的最终答案。为解决这一问题，近期工作 (Wang et al., 2024d; Jiao et al., 2024; Setlur et al., 2025) 日益聚焦于训练过程奖励模型，以在整个推理过程中检测并纠正错误，通常能比使用结果级反馈带来更大的改进。

**基于搜索的策略。** 复杂推理任务往往存在多条通向正确答案的有效路径。基于搜索的方法利用这一特性，并行探索多条候选推理轨迹，使模型能够更好地在解空间中导航。借助批评模型（critic model）的帮助，研究者开发了多种搜索策略来引导解码过程。例如，CoT-SC (Wang et al., 2023b) 采用最优 N 选一（best-of-N）方法：生成多条推理路径，并依据各结果的多数投票选出最终答案。DBS (Zhu et al., 2024) 提出将束搜索（beam search）与步骤级反馈结合，以精炼中间推理步骤；而 CoRe (Zhu et al., 2023) 与 Tree-of-Thoughts (Yao et al., 2023a) 则将推理过程显式建模为树结构，使用蒙特卡洛树搜索（MCTS）在搜索过程中平衡探索与利用。Forest-of-Thought (Bi et al., 2025) 进一步推广了这一思想：允许多棵树独立作出决策，并应用稀疏激活机制从最相关的树中筛选并选择输出。除基于树的方法外，其他方法还探索了推理的替代结构形式。Graph-of-Thoughts (Besta et al., 2024) 将中间思考组织为图中的节点，并应用基于图的操作以支持灵活的推理与信息流动。Buffer-of-Thoughts (Yang et al., 2024c) 引入一个动态记忆缓冲区，用于在推理过程中存储并实例化元层思考（meta-level thoughts）。

### 4.2 提示优化（Prompt Optimisation）

在单智能体系统中，提示在定义智能体的目标、行为与任务特定策略方面起着关键作用。提示通常包含指令、示例演示与上下文信息，引导底层大语言模型生成恰当的输出。然而，众所周知，大语言模型对提示高度敏感；措辞、格式或词序的细微变化都可能导致大语言模型行为与输出的显著改变 (Loya et al., 2023; Zhou et al., 2024b)。这种敏感性使得设计稳健且可泛化的 AI 智能体系统变得困难，从而推动了提示优化技术的发展，以自动搜索高质量提示。提示优化方法可根据其在提示空间中导航并识别能够提升模型性能的高质量提示所用的策略进行分类。本节中，我们综述并总结四类代表性方法：基于编辑的方法、生成式方法、基于文本梯度的方法与进化式方法。

#### 4.2.1 基于编辑的提示优化（Edit-Based Prompt Optimisation）

提示优化的早期尝试聚焦于基于编辑的方法，即通过预定义的编辑操作（如标记插入、删除或替换）迭代精炼人工编写的提示 (Prasad et al., 2023; Pan et al., 2024a; Lu et al., 2024c; Zhang et al., 2023b; Zhou et al., 2023a; Agarwal et al., 2024)。这些方法将提示优化视为提示空间上的局部搜索问题，旨在逐步提升提示质量，同时保留原始指令的核心语义。例如，GRIPS (Prasad et al., 2023) 将指令切分为短语，并应用短语级编辑操作——删除、交换、改写与添加——以逐步改进提示质量。Plum (Pan et al., 2024a) 通过融入模拟退火、变异与交叉等元启发式策略扩展了 GRIPS。TEMPERA (Zhang et al., 2023b) 进一步将编辑过程建模为强化学习问题，训练一个策略模型以高效地执行不同的编辑技术，构造依赖查询的提示。

#### 4.2.2 生成式提示优化（Generative Prompt Optimisation）

与对提示施加局部修改的基于编辑的方法不同，生成式方法利用大语言模型，在基础提示与各种优化信号的条件下迭代生成全新的提示。与局部编辑相比，生成式方法能够探索提示空间中更广阔的区域，产生更多样、语义更丰富的候选。

提示生成过程通常由多种优化信号驱动，这些信号引导大语言模型产生改进的提示。此类信号可能包括预定义的改写规则 (Xu et al., 2022; Zhou et al., 2024a)、输入输出示例 (Zhou et al., 2023c; Xu et al., 2024b) 以及数据集或程序描述 (Opsahl-Ong et al., 2024)。额外的引导还可能来自带评估分数的历史提示 (Yang et al., 2024a)、规定任务目标与约束的元提示（meta-prompt）(Ye et al., 2023; Hsieh et al., 2024; Wang et al., 2024i; Xiang et al., 2025)，以及指示期望变化方向的信号 (Fernando et al., 2024; Guo et al., 2024b; Opsahl-Ong et al., 2024)。此外，一些方法还利用成功与失败案例来凸显有效或有问题的提示模式 (Wu et al., 2024b; Yao et al., 2024)。例如，OPRO (Yang et al., 2024a) 通过向大语言模型提供先前生成的候选及其评估分数来生成新指令。StraGo (Wu et al., 2024b) 利用成功与失败案例中的洞见，识别获得高质量提示的关键因素。

这些优化信号还可进一步整合进高级搜索策略中，例如吉布斯采样（Gibbs sampling）(Xu et al., 2024b)、蒙特卡洛树搜索（MCTS）(Wang et al., 2024i)、贝叶斯优化（Bayesian optimisation）(Opsahl-Ong et al., 2024; Lin et al., 2024b; Hu et al., 2024; Schneider et al., 2025; Wan et al., 2025) 以及基于神经多臂赌博机的方法 (Lin et al., 2024b; Shi et al., 2024a; Lin et al., 2024a)。这些搜索策略使得对提示空间更高效、更可扩展的探索成为可能。例如，PromptAgent (Wang et al., 2024i) 将提示优化形式化为一个策略规划问题，并利用 MCTS 高效地在专家级提示空间中导航。MIPRO (Opsahl-Ong et al., 2024) 采用贝叶斯优化，高效搜索指令候选与少样本演示（few-shot demonstrations）的最优组合。

虽然大多数生成式方法使用冻结的大语言模型来生成新提示，近期工作也开始探索利用强化学习训练策略模型进行提示生成 (Deng et al., 2022; Sun et al., 2024a; Yao et al., 2024; Wang et al., 2025k)。例如，Retroformer (Yao et al., 2024) 训练一个策略模型，通过总结先前失败案例的根因来迭代精炼提示。

#### 4.2.3 基于文本梯度的提示优化（Text Gradient-Based Prompt Optimisation）

除直接编辑与生成提示外，一条更新的研究路线探索利用文本梯度（text gradient）来引导提示优化 (Pryzant et al., 2023; Yuksekgonul et al., 2024; Wang et al., 2024g; Austin and Chartock, 2024; Yüksekgönül et al., 2025; Tang et al., 2025c; Zhang et al., 2025l)。这些方法从神经网络的基于梯度的学习中获得灵感，但并非计算模型参数上的数值梯度，而是生成自然语言反馈——被称为"文本梯度"——以指导提示应如何更新来优化给定目标。一旦获得文本梯度，提示便根据该反馈进行更新。这类方法的关键组成部分在于文本梯度如何生成，以及随后如何利用它更新提示。例如，ProTeGi (Pryzant et al., 2023) 通过批评当前提示来生成文本梯度，随后沿梯度的相反语义方向编辑提示。这类"梯度下降"步骤由束搜索与多臂赌博机选择过程引导，以高效寻找最优提示。类似地，TextGrad (Yuksekgonul et al., 2024; Yüksekgönül et al., 2025) 将该思想推广为面向复合 AI 系统的更通用框架：它将文本反馈视为一种"自动微分"（automatic differentiation），并利用大语言模型生成的建议迭代改进提示、代码或其他符号变量等组件。另一项工作 (Zhou et al., 2024c) 提出智能体符号学习（agent symbolic learning），这是一种以数据为中心的框架，将语言智能体建模为符号网络，使其能够通过反向传播与梯度下降的符号类比来自主优化自身的提示、工具与工作流。近期工作 (Wu et al., 2025c) 还探索了复合 AI 系统中的提示优化，其目标是自动优化异构组件与参数集合（如模型参数、提示、模型选择以及超参数）上的配置。

#### 4.2.4 进化式提示优化（Evolutionary Prompt Optimisation）

除上述优化技术外，进化算法（evolutionary algorithms）也被探索为提示优化的灵活有效方法 (Guo et al., 2024b; Fernando et al., 2024)。这些方法将提示优化视为一个进化过程：维护一个候选提示种群，通过变异、交叉与选择等进化算子迭代精炼。例如，EvoPrompt (Guo et al., 2024b) 利用两种广泛使用的进化算法——遗传算法（Genetic Algorithm, GA）与差分进化（Differential Evolution, DE）——引导优化过程以寻找高性能提示。它将变异与交叉这两项核心进化操作适配到提示优化场景中：通过组合两个父代提示的片段并引入对特定元素的随机改动来生成新的候选提示。类似地，Promptbreeder (Fernando et al., 2024) 也通过迭代变异任务提示（task-prompt）种群来进化这些提示。其一个关键特征是使用变异提示（mutation prompts），即规定变异过程中任务提示应如何被修改的指令。这些变异提示既可以是预定义的，也可以由大语言模型自身动态生成，从而为引导提示进化提供灵活且自适应的机制。

### 4.3 记忆优化（Memory Optimisation）

记忆对于智能体（agent）在长程任务中进行推理、适应和有效运作至关重要。然而，AI 智能体经常面临上下文窗口受限和遗忘带来的限制，这可能导致上下文漂移（context drift）和幻觉（hallucination）等现象（Liu et al., 2024b; Zhang et al., 2024c,d）。这些限制促使人们对记忆优化（memory optimisation）产生了日益浓厚的兴趣，以实现在动态环境中可泛化且一致的行为。在本综述中，我们聚焦于推理时（inference-time）记忆策略，这些策略在不修改模型参数的情况下增强记忆利用。与微调或知识编辑（knowledge editing）等训练时（training-time）技术（Cao et al., 2021; Mitchell et al., 2022）相比，推理时方法在推理过程中动态决定保留、检索和丢弃什么内容。

我们将现有方法划分为两个优化目标：短期记忆（short-term memory），侧重于维持活动上下文中的连贯性；以及长期记忆（long-term memory），支持跨会话的持久检索。这种面向优化的视角将关注点从静态记忆形式（例如内部 vs. 外部）转向动态记忆控制，强调记忆如何被调度、更新和复用以支持决策。在以下小节中，我们介绍每个类别中的代表性方法，强调它们对推理保真度（reasoning fidelity）以及长时程（long-horizon）场景下有效性的影响。

#### 4.3.1 短期记忆优化（Short-term Memory Optimisation）

短期记忆优化侧重于管理 LLM 工作记忆（working memory）中有限的上下文信息（Liu et al., 2024b）。这通常包括最近的对话轮次、中间推理轨迹以及来自当前上下文的与任务相关的内容。随着上下文的扩展，记忆需求显著增加，使得在固定的上下文窗口内保留所有信息变得不切实际。为了解决这个问题，研究者提出了各种技术来压缩、总结或选择性地保留关键信息（Zhang et al., 2024d; Wang et al., 2025d）。常见策略包括总结（summarisation）、选择性保留（selective retention）、稀疏注意力（sparse attention）和动态上下文过滤（dynamic context filtering）。例如，Wang et al. (2025d) 提出了递归总结（recursive summarisation），逐步构建紧凑而全面的记忆表征，从而在长时间交互中提供一致的响应。MemoChat (Lu et al., 2023) 维护从对话历史中派生出的对话级记忆，以支持连贯且个性化的交互。COMEDY (Chen et al., 2025f) 和 ReadAgent (Lee et al., 2024d) 进一步将提取或压缩的记忆轨迹纳入生成过程，使智能体能够在长对话或长文档中保持上下文。除总结之外，其他方法动态调整上下文或检索中间状态轨迹，以促进多跳推理（multi-hop reasoning）。例如，MoT (Li and Qiu, 2023) 和 StructRAG (Li et al., 2025i) 检索自生成或结构化的记忆来指导中间步骤。MemoryBank (Zhong et al., 2024) 受艾宾浩斯遗忘曲线（Ebbinghaus forgetting curve）(Murre and Dros, 2015) 启发，对事件进行分层总结，并根据近因性和相关性更新记忆。Reflexion (Shinn et al., 2023) 使智能体能够反思任务反馈并存储情景性洞见，促进随时间的自我改进。

这些方法显著改善了局部连贯性和上下文效率。然而，仅靠短期记忆不足以跨会话保留知识或实现长时程上的泛化，这凸显了对互补性长期记忆机制的需求。

#### 4.3.2 长期记忆优化（Long-term Memory Optimisation）

长期记忆优化通过提供超越语言模型即时输入范围的持久且可扩展的存储，缓解短上下文窗口的局限。它使智能体能够跨会话保留和检索事实知识、任务历史、用户偏好和交互轨迹（Du et al., 2025），从而支持随时间推移的连贯推理和决策。该领域的一个关键目标是在保持记忆存储与推理过程清晰分离的同时，管理日益复杂和不断扩展的记忆空间（Zhang et al., 2024d）。外部记忆既可以是无结构的，也可以组织为元组、数据库或知识图谱（knowledge graph）等结构化形式（Zeng et al., 2024b），并且可能跨越广泛的来源和模态。

长期记忆优化的一个关键范式是检索增强生成（Retrieval-Augmented Generation, RAG），它通过检索将相关的外部记忆纳入推理过程（Wang et al., 2023a; Efeoglu and Paschke, 2024; Gao et al., 2025c）。例如，EWE (Chen et al., 2025d) 用显式工作记忆增强语言模型，该工作记忆动态持有检索段落（passage）的潜在表征，重点是在每个解码步骤组合静态记忆条目。相比之下，A-MEM (Xu et al., 2025) 通过动态索引和链接构建相互关联的知识网络，使智能体能够形成不断演化的记忆。另一个突出的方向是智能体式检索（agentic retrieval），即智能体自主决定何时检索以及检索什么；与之相伴的是轨迹级记忆（trajectory-level memory），即利用过去的交互来指导未来行为。高效索引、记忆剪枝（memory pruning）和压缩等支持性技术进一步增强了可扩展性（Zheng et al., 2023a; Alizadeh et al., 2024）。例如，Wang et al. (2024e) 提出了基于 RAG 范式的轻量级反学习（unlearning）框架。通过改变用于检索的外部知识库，系统可以在不修改底层 LLM 的情况下模拟遗忘效果。类似地，Xu et al. (2025) 引入了一个自演化记忆系统，在不依赖预定义操作的情况下维持长期记忆。除了检索策略和记忆控制机制外，记忆本身的结构和编码方式也显著影响系统性能。基于向量的记忆系统（vector-based memory system）在稠密潜在空间中编码记忆，并支持快速、动态的访问。例如，MemGPT (Packer et al., 2023)、NeuroCache (Safaya and Yuret, 2024)、G-Memory (Zhang et al., 2025e) 和 AWESOME (Cao and Wang, 2024) 实现了跨任务的巩固（consolidation）和复用。Mem0 (Chhikara et al., 2025) 进一步引入了面向生产的以记忆为中心的架构，用于持续提取和检索。其他方法从生物或符号系统（symbolic system）中汲取灵感以提高可解释性。HippoRAG (Gutierrez et al., 2024) 通过轻量级知识图谱实现了受海马体启发的索引。GraphReader (Li et al., 2024d) 和 Mem0g (Chhikara et al., 2025) 使用基于图的结构来捕捉对话依赖并指导检索。在符号领域，ChatDB (Hu et al., 2023) 等系统对结构化数据库执行 SQL 查询，而 Wang et al. (2024f) 引入了神经符号（neuro-symbolic）框架，以自然形式和符号形式存储事实与规则，支持精确推理和记忆跟踪。

近期工作还强调了推理过程中记忆控制机制（memory control mechanism）的重要性（Zou et al., 2024; Chen et al., 2025d），这些机制决定了何时、存储什么以及如何存储、更新或丢弃记忆（Jin et al., 2025）。例如，MATTER (Lee et al., 2024b) 从多个异构记忆源中动态选择相关片段以支持问答，AWM (Wang et al., 2024l) 在在线和离线场景下都支持连续的记忆更新。MyAgent (Hou et al., 2024) 赋予智能体用于生成过程的记忆感知回忆机制，解决了 LLM 的时间认知局限。MemoryBank (Zhong et al., 2024) 提出了一种受认知科学启发的更新策略，通过定期重温过去的知识来缓解遗忘并增强长期保留。强化学习（reinforcement learning）和优先级策略（prioritisation policy）也被用于指导记忆动态（Zhou et al., 2025b; Yan et al., 2025; Long et al., 2025）。例如，MEM1 (Zhou et al., 2025c) 利用强化学习维持不断演化的内部记忆状态，选择性地整合新信息并丢弃不相关内容。A-MEM (Xu et al., 2025) 提出了一种智能体式记忆架构，可根据使用情况自主组织、更新和剪枝记忆。MrSteve (Park et al., 2024) 融合了情景式"何物-何地-何时"（"what-where-when"）记忆，对长期知识进行分层组织，支持目标导向的规划和任务执行。这些方法使智能体能够主动管理记忆，并补充短期机制。与此同时，MIRIX (Wang and Chen, 2025) 在协作场景中引入了一种具有六种专门记忆类型的智能体记忆系统，支持协调检索，并在长时程任务中取得了最先进的性能；而 Agent KB (Tang et al., 2025b) 利用带有师生双阶段检索机制的共享知识库，在智能体之间迁移跨领域的问题解决策略和执行经验，通过分层策略指导和精细化显著提升了性能。

### 4.4 工具优化（Tool Optimisation）

工具（tool）是智能体系统中的关键组件，充当允许智能体感知现实世界并与之交互的接口。它们使智能体能够访问外部信息来源、结构化数据库、计算资源和 API，从而增强智能体解决复杂现实问题的能力（Patil et al., 2024; Yang et al., 2023; Guo et al., 2024d）。因此，工具使用已成为 AI 智能体的核心能力，尤其对于需要外部知识和多步推理的任务而言。然而，仅仅让智能体接触工具是不够的。有效的工具使用要求智能体认识到何时以及如何调用正确的工具、解释工具输出，并将其整合到多步推理中。因此，近期研究聚焦于工具优化（tool optimisation），旨在增强智能体智能、高效地使用工具的能力。

现有关于工具优化的研究大致分为两个互补的方向。第一个方向得到了更广泛的探索，侧重于增强智能体与工具交互的能力。这通过不同方法实现，包括训练策略、提示（prompting）技术和推理算法，旨在提高智能体有效理解、选择和执行工具的能力。第二个方向更为新兴，侧重于通过修改现有工具或创建与目标任务功能需求更契合的新工具来优化工具本身。

#### 4.4.1 基于训练的工具优化（Training-Based Tool Optimisation）

基于训练的工具优化旨在通过学习更新底层 LLM 的参数来增强智能体使用工具的能力。这一方法背后的动机源于 LLM 纯粹在文本生成任务上进行预训练，从未接触过工具使用或交互式执行。因此，它们缺乏如何调用外部工具和解释工具输出的内在理解。基于训练的方法旨在通过显式地教授 LLM 如何与工具交互来解决这一局限，从而将工具使用能力直接嵌入智能体的内部策略中。

**用于工具优化的监督微调（Supervised Fine-Tuning for Tool Optimisation）。** 该方向早期的努力依赖于监督微调（supervised fine-tuning, SFT），即在高质量工具使用轨迹上训练 LLM，以显式演示应如何调用工具并将其整合到任务执行中（Schick et al., 2023; Du et al., 2024; Liu et al., 2025g; Wang et al., 2025e）。这些方法的一个核心焦点在于收集高质量的工具使用轨迹，这些轨迹通常由输入查询、中间推理步骤、工具调用和最终答案组成。这些轨迹为智能体提供显式的监督信号，教会它如何规划工具使用、执行调用并将结果纳入其推理过程。例如，ToolLLM (Qin et al., 2024) 和 GPT4Tools (Yang et al., 2023) 等方法利用更强大的 LLM 生成指令和相应的工具使用轨迹。受人类学习过程启发，STE (Wang et al., 2024a) 引入了模拟的试错交互来收集工具使用示例，而 TOOLEVO (Chen et al., 2025b) 采用蒙特卡洛树搜索（Monte Carlo Tree Search, MCTS）实现更主动的探索并收集更高质量的轨迹。T3-Agent (Gao et al., 2025d) 进一步将该范式扩展到多模态场景，引入数据合成流水线（pipeline），为微调视觉-语言模型（vision–language model）生成并验证高质量的多模态工具使用轨迹。此外，近期工作（Yao et al., 2025）表明，即使是先进的 LLM 在多轮交互中的工具使用也面临挑战，尤其是当这些交互涉及复杂函数调用、长期依赖或请求缺失信息时。为了生成高质量的多轮工具调用训练轨迹，Magnet (Yin et al., 2025) 提出从工具合成查询序列和可执行函数调用序列，并利用图构建可靠的多轮查询。BUTTON (Chen et al., 2025e) 通过两阶段过程生成合成的组合式指令微调数据：自底向上阶段组合原子任务以构建指令，自顶向下阶段采用多智能体系统模拟用户、助手和工具来生成轨迹数据。为了实现更真实的数据生成，APIGen-MT (Prabhakar et al., 2025) 提出了一个两阶段框架，首先生成工具调用序列，然后通过模拟的人机（human-agent）交互将其转化为完整的多轮交互轨迹。

一旦收集到工具使用轨迹，就通过标准语言建模目标对 LLM 进行微调，使模型学习工具调用和整合的成功模式。除了这一常见范式外，一些研究还探索了更先进的训练策略以进一步增强工具使用能力。例如，Confucius (Gao et al., 2024a) 引入了由易到难的课程学习（curriculum learning）范式，逐步让模型接触日益复杂的工具使用场景。Gorilla (Patil et al., 2024) 提出将文档检索器（document retriever）整合到训练流水线中，使智能体能够通过将工具使用锚定在检索到的文档上来动态适应不断演化的工具集。

**用于工具优化的强化学习（Reinforcement Learning for Tool Optimisation）。** 虽然监督微调已被证明能有效教会智能体使用工具，但其性能常常受限于训练数据的质量和覆盖范围。低质量的轨迹可能导致性能提升有限。此外，在有限数据集上微调可能阻碍泛化，尤其当智能体在推理时遇到未见过的工具或任务配置时。为解决这些局限，近期研究转向强化学习（reinforcement learning, RL）作为工具使用的替代优化范式。通过让智能体在交互和反馈中学习，RL 促进了更具适应性和鲁棒性的工具使用策略的发展。这一方法在 ReTool (Feng et al., 2025a) 和 Nemotron-Research-Tool-N1 (Tool-N1) (Zhang et al., 2025m) 等近期工作中展现出有前景的结果，两者都证明了交互环境中轻量级监督如何带来更可泛化的工具使用能力。Tool-Star (Dong et al., 2025a) 通过将可扩展的工具集成数据合成与两阶段训练框架相结合，增强了基于 RL 的工具使用，以改进自主多工具协作推理。SPORT (Li et al., 2025d) 通过逐步偏好优化（step-wise preference optimisation）将基于 RL 的工具优化扩展到多模态场景，使智能体能够在无需人工标注的情况下自合成任务、探索和验证工具使用。在这些基础之上，进一步的研究聚焦于改进用于工具使用的 RL 算法，包括 ARPO (Dong et al., 2025b)，它通过基于熵的自适应回滚（rollout）机制和逐步优势归因（stepwise advantage attribution）来平衡长时程推理与多轮工具交互；此外还有设计更有效奖励函数的方法（Qian et al., 2025a），以及利用合成数据生成与过滤来增强训练稳定性和效率的方法（Goldie et al., 2025）。

#### 4.4.2 推理时工具优化（Inference-Time Tool Optimisation）

除了基于训练的方法外，另一条工作线聚焦于在不修改 LLM 参数的情况下增强推理过程中的工具使用能力。这些方法通常通过优化提示中的工具相关上下文信息，或在测试时通过结构化推理引导智能体的决策过程来运作。该范式内有两个主要方向：（1）基于提示的方法（prompt-based method），优化工具文档或指令的表征，以促进对工具的更好理解和利用；（2）基于推理的方法（reasoning-based method），利用测试时推理策略，如 MCTS 和其他基于树的算法，在推理过程中实现对工具更有效的探索和选择。

**基于提示的工具优化（Prompt-Based Tool Optimisation）。** 工具相关信息通常通过提示中的工具文档提供给智能体。这些文档描述工具功能、潜在用途和调用格式，帮助智能体理解如何与外部工具交互以解决复杂任务。因此，提示中的工具文档充当智能体与其可用工具之间的关键桥梁，直接影响工具使用决策的质量。近期工作聚焦于优化这些文档的呈现方式，要么重构源文档，要么通过交互式反馈加以精炼（Qu et al., 2025）。例如，EASYTOOL (Yuan et al., 2025b) 将不同的工具文档转化为统一、简洁的指令，使 LLM 更易使用。相比之下，DRAFT (Qu et al., 2025) 和 PLAY2PROMPT (Fang et al., 2025) 等方法从人类试错过程中汲取灵感，引入交互式框架，根据反馈迭代式地精炼工具文档。

除这些方法外，一个更新的方向探索了工具文档与提供给 LLM 智能体的指令的联合优化。例如，Wu et al. (2025a) 提出了一个优化框架，同时精炼智能体的提示指令和工具描述（统称为上下文（context）），以增强它们之间的交互。优化后的上下文已被证明能减少计算开销并提高工具使用效率，凸显了上下文设计在有效推理时工具优化中的重要性。

**基于推理的工具优化（Reasoning-Based Tool Optimisation）。** 测试时推理和规划技术已展现出改善 AI 智能体工具使用能力的强大潜力。ToolLLM (Qin et al., 2024) 等早期工作验证了 ReAct (Yao et al., 2023b) 框架在工具使用场景中的有效性，并进一步提出了一种深度优先树搜索（depth-first tree search）算法，使智能体能够快速回溯到最后一个成功状态，而不是从头重新开始，从而显著提高效率。ToolChain (Zhuang et al., 2024) 引入了一种更高效的基于树的搜索算法，利用成本函数估算给定分支的未来成本。这使得智能体能够提前剪除低价值路径，避免传统 MCTS 常见的那种低效回滚。类似地，Tool-Planner (Liu et al., 2025h) 将功能相似的工具聚类到工具包（toolkit）中，并利用基于树的规划方法从这些工具包中快速重新选择和调整工具。MCP-Zero (Fei et al., 2025) 引入了一个主动智能体框架，使 LLM 能够自主识别能力差距并按需请求工具。

#### 4.4.3 工具功能优化（Tool Functionality Optimisation）

除了优化智能体的行为外，一条互补的工作线聚焦于修改或生成工具本身，以更好地支持特定任务的推理和执行。受人类为满足任务需求而不断开发工具的做法启发，这些方法旨在通过使工具集适应任务来扩展智能体的动作空间，而不是使任务适应固定的工具集（Wang et al., 2024k）。例如，CREATOR (Qian et al., 2023) 和 LATM (Cai et al., 2024) 引入了为新任务生成工具文档和可执行代码的框架。CRAFT (Yuan et al., 2024a) 利用先前任务中可复用的代码片段为未见场景创建新工具。AgentOptimiser (Zhang et al., 2024b) 将工具和函数视为可学习的权重，使智能体能够使用基于 LLM 的更新来迭代式地精炼它们。更新的工作 Alita (Qiu et al., 2025) 将工具创建扩展到多组件程序（Multi-Component Program, MCP）格式，增强了可复用性和环境管理。此外，CLOVA (Gao et al., 2024b) 引入了一个具有推理、反思和学习阶段的闭环视觉助手框架，使视觉工具能够基于人类反馈持续适应。

## 5 多智能体优化（Multi-Agent Optimisation）

多智能体工作流（multi-agent workflow）定义了多个智能体如何通过结构化的拓扑结构和交互模式协作解决复杂任务。该领域经历了一个根本性转变：从手工设计的智能体架构——研究者显式指定协作模式与通信协议——转向能够自动发现有效协作策略的自进化系统。这一演进将工作流设计重新定义为对三个相互关联空间的搜索问题：可能的智能体拓扑结构空间、智能体角色与指令的语义空间，以及 LLM 主干的能力空间。近期研究利用一系列优化技术探索这些空间，从进化算法到强化学习，每种技术在平衡多个优化目标（如准确率、效率和安全性）时都提供不同的权衡取舍。

本节沿四个关键维度追溯多智能体工作流优化的演进历程。我们的起点是考察建立基础原则的手工设计范式；接着讨论提示优化（prompt optimisation），即在固定拓扑内精炼智能体行为；随后讨论拓扑优化（topology optimisation），其重点是发现多个智能体完成给定任务时最有效的架构；我们还会讨论综合性方法，它们同时考虑多个优化空间，以集成方式联合优化提示、拓扑及其他系统参数。此外，我们还研究 LLM 主干优化（LLM-backbone optimisation），即通过针对性训练增强智能体自身的基础推理与协作能力。透过这一视角，我们将展示该领域如何逐步扩展其对多智能体系统中"可搜索、可优化参数"的界定——从智能体指令与通信结构，一直到底层模型的核心能力。图 6 从核心要素与关键维度两个层面给出了多智能体工作流优化的总览。

```
多智能体优化（Multi-Agent Optimisation）
├── 优化要素（Elements）
│   ├── 优化空间（Optimisation Space）：文本（Text）、代码（Code）、图（Graph）、分布（Distribution）
│   ├── 优化方法（Optimisation Method）：LLM 树搜索（LLM Tree Search）、强化学习梯度（RL Gradient）
│   └── 优化目标（Optimisation Target）：准确率（Accuracy）、效率（Efficiency）、安全性（Safety）
└── 优化维度（Dimensions）
    ├── 提示（Prompt）：提示优化（Prompt Optimisation）
    ├── 拓扑（Topology）：代码级工作流（Code-level Workflows）、通信图拓扑（Communication-graphs Topologies）
    │   ├── 基于代码的方法（Code-based Approaches）
    │   ├── 基于搜索的方法（Search-based Approaches）
    │   └── 基于学习的方法（Learning-based Approaches）
    ├── 统一（Unified）
    └── LLM 主干（LLM Backbone）：面向推理的优化（Reasoning-oriented Optimisation）、面向协作的优化（Collaboration-oriented Optimisation）
```

图 6 多智能体系统优化方法总览：左侧为核心优化要素（空间、方法与目标），右侧为优化维度（提示、拓扑、统一与 LLM 主干）。

### 5.1 手工设计的多智能体系统（Manually Designed Multi-Agent Systems）

手工设计的工作流构成了多智能体协作研究的基础。这些架构将研究者关于任务分解、智能体能力与协调机制的理解编码为显式的交互模式。通过考察这些手工设计的范式，我们能够理解指导智能体协作的设计原则，以及塑造系统架构的工程考量。

**并行工作流（Parallel Workflows）。** 并行工作流采用并发执行后集体决策的方式。其最简单的形式是多个独立智能体并行生成解决方案，随后通过多数投票选择最终输出。经验证据表明，使用小型 LLM 的并行生成可以匹配甚至超越单个大型 LLM（Verga et al., 2024; Wang et al., 2025a）。多层聚合进一步降低误差界并提升鲁棒性（Zhang et al., 2025d）。近期的扩展引入了动态任务图与异步线程，以实现近线性扩展和更低的决策延迟（Yu et al., 2025; Gu et al., 2025; Wang et al., 2025c）。然而，尽管计算吞吐量可以横向扩展，管理协调与一致性的工程成本却呈指数增长。

**层次化工作流（Hierarchical Workflows）。** 当子任务存在严格的上下文依赖时，层次化（Zhang et al., 2024c; Qian et al., 2024）工作流提供了一种结构化替代方案。这些框架将智能体组织为多层自上而下的结构或顺序流水线。系统跨层分解任务，每一层负责不同的子任务。这种设计在深度研究和代码生成等复杂目标驱动型任务中表现出色（Hong et al., 2024; Zhang et al., 2025n）。然而，其固定拓扑限制了适应性，尤其是在面对动态目标或资源约束时。

**多智能体辩论（Multi-Agent Debate）。** 为在准确性与可解释性之间取得平衡，研究者发展出辩论范式：智能体通过对抗—协商—仲裁循环讨论并纠正推理错误。早期工作探索了对称辩论者机制（Li et al., 2024g）。近期研究通过引入角色不对称、可调节的辩论强度以及以说服力为导向的策略扩展了这一框架（Yin et al., 2023; Liang et al., 2024; Khan et al., 2024; Chang, 2024）。此外，置信度门控的辩论策略表明，仅在单个模型置信度较低时才触发多智能体辩论，可以在不损害性能的前提下大幅降低推理成本（Eo et al., 2025）。

尽管手工设计的工作流与结构化多智能体范式取得了成功，但近期的实证研究揭示，带有精心设计提示的单个大型 LLM 在多个推理基准上可以匹敌复杂多智能体讨论框架的性能（Pan et al., 2025a）。这一发现，加上手工制作多智能体工作流的高实现与维护成本（Li et al., 2024h; Zhang et al., 2025j），推动了自进化多智能体系统（self-evolving multi-agent systems）的发展——这类系统能够随时间自动学习、适应并重组自身工作流，而非依赖固定架构与静态协调协议。

### 5.2 自进化多智能体系统（Self-Evolving Multi-Agent System）

手工设计多智能体工作流的高工程成本与有限适应性，促使研究转向自动化、自进化的系统。这类系统能够通过基于性能反馈调整其提示、拓扑与协作策略，自动设计、评估并改进智能体工作流。它们不依赖硬编码配置，而是将工作流优化视为一个搜索问题：系统在可能的配置空间中进行探索与优化。该搜索空间横跨多个层级，从局部提示到全局拓扑结构。

为有效导航搜索空间，研究者引入了多种搜索算法。这些方法涵盖强化学习、蒙特卡洛树搜索（Monte Carlo Tree Search）以及能够实现高效探索的生成式模型，也包括提供稳健搜索能力的进化算子。此外，优化目标已从提升性能扩展到平衡多维度目标，包括任务准确率、计算效率与安全性。这一演进表明，随着搜索能力的进步，核心挑战从寻找最优解转变为在多智能体动态情境中定义"最优"的含义。

#### 5.2.1 多智能体提示优化（Multi-Agent Prompt Optimisation）

实现此类自进化的一条有前景的途径是提示优化，其中提示同时定义了智能体角色及其对应的任务指令。近期方法将这些以提示编码的配置视为可供系统化精炼的正式搜索空间。事实上，多智能体工作流中的提示优化常常建立在第 4.2 节讨论的单智能体技术之上，但将其扩展以协调多个智能体与任务依赖关系。例如，DSPy (Singhvi et al., 2023) 的 Assertions 引入运行时自进化，其搜索空间涵盖流水线模块可能产生的中间输出，利用带显式反馈的断言驱动回溯引导 LLM 自我纠正违反程序化约束的输出。AutoAgents (Chen et al., 2024b) 将提示优化从单智能体设置扩展到整个多智能体团队配置，通过专职元智能体之间的结构化对话优化专业化智能体角色与执行计划。

#### 5.2.2 拓扑优化（Topology Optimisation）

拓扑优化代表了多智能体系统设计的范式转变：不再将通信结构视为固定约束，而是将拓扑本身视为一个强大的优化目标。这一洞见源于一个基本观察——即使是最佳的提示也无法弥补糟糕的架构选择。从以表征为中心的视角来看，现有工作可分为两个互补的家族：程序/代码级工作流拓扑与通信图拓扑；这一分类凸显了被优化的对象——拓扑所选用的表征形式。这不仅是技术上的进步，更是概念上的转变——媒介（拓扑）与信息（提示）同等重要。

**代码级工作流（Code-level workflows）。** 将工作流表示为可执行程序或类型化代码图，使智能体协调变得显式且可验证，从而实现组合式复用与自动化检查。AutoFlow (Li et al., 2024h) 将搜索空间设定为自然语言程序（CoRE），并使用强化学习训练一个生成器 LLM，同时支持微调与上下文内使用。与 AutoFlow 相比，AFlow (Zhang et al., 2025j) 用类型化、可复用的算子取代自然语言程序空间以构成代码图；在广阔设计空间上，采用 LLM 引导扩展与软概率选择的蒙特卡洛树搜索比在 CoRE 上进行强化学习能够提供更结构化、样本效率更高的探索。在这些离散搜索方案的基础上，ScoreFlow (Wang et al., 2025j) 将代码表征提升到连续空间，并应用基于梯度的优化与 Score-DPO（一种融入定量反馈的直接偏好优化变体）来改进工作流生成器。这解决了 RL/MCTS 固有的探索低效问题，并实现了任务级自适应的工作流生成。与基于搜索的优化正交，MAS-GPT (Ye et al., 2025) 在面向一致性的语料（智能体间一致性与智能体内一致性）上进行监督微调，使单次推理即可生成完整、可执行的 MAS 代码库，以广泛的搜索覆盖换取一次性效率，同时更依赖数据质量。

**通信图拓扑（Communication-graph topologies）。** 与代码级程序不同，这一路线将工作流视为多智能体通信图，其中连接本身即为优化目标（Liu et al., 2025i）。GPTSwarm (Zhuge et al., 2024a) 将其搜索空间定义为智能体计算图内的连接。它将这一离散空间松弛为连续的边概率，同样采用强化学习学习最优连接方案。在 GPTSwarm 的基础上，DynaSwarm (Leong and Wu, 2025) 将搜索空间从单一优化图扩展为一组图结构的组合，采用 Actor–Critic（A2C）优化与轻量级图选择器进行逐实例拓扑选择，以应对一个关键观察：不同查询需要不同的图结构才能达到最优性能。G-Designer (Zhang et al., 2024a) 不在固定空间中遮蔽边，而是采用变分图自编码器直接生成任务自适应的通信图，通过调节结构复杂度在质量与 token 成本之间取得平衡。MermaidFlow (Zheng et al., 2025) 将拓扑表示为带静态验证的类型化声明式图，并借助安全约束的进化算子仅探索语义有效区域。

在静态图合成之外，一些方法在执行过程中动态调制通信图。DyLAN (Liu et al., 2023b) 将搜索空间视为带早停时间轴的跨层活跃智能体；它通过 LLM 排序器剪除低价值智能体，并利用智能体重要性分数（Agent Importance Score）通过传播—聚合—选择执行自动化团队优化。Captain Agent (Song et al., 2024) 将搜索空间定义为子任务专属的智能体与工具集合（经检索、过滤，必要时生成）；嵌套式小组对话与反思迭代式地就地精炼团队构成，而非从头合成固定图。Flow (Niu et al., 2025) 与 DyLAN 的剪枝和 Captain Agent 的团队重组形成对比，它动态调整 AOV 图结构：通过并行度/依赖度量选择初始图，再经由工作流精炼与子任务重分配在线改进该图，以最小协调成本实现模块化并发。

与图合成正交，剪枝方法通过移除冗余或高风险通信同时保留必要协作来进行优化。AgentPrune (Zhang et al., 2025g) 将搜索空间视为时空通信图，其中对话内（空间）与对话间（时间）边均为剪枝目标；它采用可训练的低秩引导图掩码，通过一次性剪枝识别并消除冗余通信，以优化 token 经济性。在这一剪枝范式之上，AGP（自适应图剪枝，Adaptive Graph Pruning）(Li et al., 2025a) 将搜索空间扩展为同时涵盖智能体数量（硬剪枝）与通信边（软剪枝）。它采用两阶段训练策略，在逐任务基础上联合优化这些维度，动态确定最优智能体数量及其连接以生成任务特定拓扑。上述方法为效率与适应性而剪枝，而 G-Safeguard (Wang et al., 2025f) 将剪枝用于安全——它以通信边为搜索空间，使用 GNN 标记风险节点，并以确定性规则在模型驱动的阈值下切断出向边以防御对抗攻击。相关地，NetSafe (Yu et al., 2024a) 总结了拓扑安全风险，并提出基于图的检测与干预原则，作为互补的安全视角。

#### 5.2.3 统一优化（Unified Optimisation）

统一优化源于一个关键洞见：提示与拓扑并非相互独立的设计选择，而是智能体系统深度互联的两个方面（Zhou et al., 2025a）。精心设计的提示在糟糕的通信结构中无法有效发挥作用，而优雅的拓扑在指令欠佳的智能体面前也收效甚微。这种相互依赖性推动该领域沿三条不同技术路径发展：基于代码的统一、结构化优化方法与学习驱动架构。每种方法都从独特角度应对联合优化挑战，在效率与性能之间揭示出不同的权衡。

**基于代码的方法（Code-based Approaches）。** 统一优化最直接的方法是将代码作为提示与拓扑的统一表征。ADAS (Hu et al., 2025a) 通过其元智能体搜索（Meta Agent Search）框架开创了这一方法，将提示、工作流与工具使用表示为 Python 代码，以实现迭代式智能体生成与评估。这种以代码为中心的视角允许自然的协同进化：修改智能体逻辑会同时影响其指令层面与结构层面。FlowReasoner (Gao et al., 2025a) 推进了基于代码的范式，聚焦于查询级自适应，为每个查询而非每个任务生成一个 MAS。在从 DeepSeek-R1 蒸馏推理能力后，它采用带外部执行反馈的 GRPO 增强其元智能体，以优化性能与效率。这些方法共同表明，代码为联合优化提供了灵活的基底，尽管自适应的粒度各不相同。

**基于搜索的方法（Search-based Approaches）。** 另一条工作线不依赖通过代码进行的隐式协同进化，而是开发显式机制来协调提示与拓扑设计。EvoAgent (Yuan et al., 2025a) 将搜索空间定义为文本形式的智能体设置（角色、技能、提示），并采用带变异、交叉与选择算子的进化算法生成多样化的智能体群体。与基于代码的隐式协同进化相比，EvoAgent 显式进化配置层面的特征，而非合成程序。相对于 EvoAgent 以文本为中心的配置搜索，EvoFlow (Gao et al., 2025a) 同样采用进化搜索，但对象是算子节点工作流图。它引入预定义的复合算子（如 CoT、辩论），并使用带标签选择的算子库约束变异/交叉，缩小搜索空间。EvoFlow 进一步将 LLM 选择作为决策变量以平衡性能与成本；多样性感知的选择保持群体多样性，多目标适应度驱动成本—性能的帕累托（Pareto）优化。

作为进化搜索的补充，MASS (Zhou et al., 2025a) 提出一种三阶段、条件耦合的优化框架：首先局部调优每个智能体的提示，然后在剪枝后的空间中搜索工作流拓扑，最后在选定拓扑上进行全局提示优化；该过程交替进行而非完全解耦，作为联合优化的一种实用近似。最近，DebFlow (Su et al., 2025) 将搜索空间表示为算子节点的工作流图，并采用多智能体辩论进行优化。在执行失败的反省（reflexion）引导下，它避免穷举搜索，同时在自动化智能体设计中开创了辩论机制。这些结构化方法以部分灵活性换取更具针对性的优化策略。在算子节点表征的基础上，MAS-ZERO (Ke et al., 2025) 将统一优化视为纯粹的推理时搜索，通过可解性引导的精炼迭代重组智能体团队与任务分解，无需任何梯度更新或离线训练。

**基于学习的方法（Learning-based Approaches）。** 最新一波研究应用复杂的学习范式联合优化提示与拓扑。MaAS (Zhang et al., 2025f) 从优化单一架构转向学习智能体超网络（agentic supernets）——多智能体系统上的概率分布。其控制器网络借助蒙特卡洛与文本梯度优化采样查询特定的架构，以大幅降低的推理成本实现卓越性能。ANN (Ma et al., 2025) 将多智能体协作概念化为分层神经网络，每一层形成专业化智能体团队。它采用两阶段优化过程：前向任务分解与后向文本梯度精炼。这一方法联合进化智能体角色、提示与层间拓扑，支持对新颖任务的训练后自适应。

#### 5.2.4 LLM 主干优化（LLM Backbone Optimisation）

智能体背后 LLM 主干的进化是多智能体进化的关键方面，尤其是智能体如何通过交互提升其协作或推理能力。

**面向推理的优化（Reasoning-oriented Optimisation）。** 一条突出的工作线聚焦于通过多智能体协作增强主干 LLM 的推理能力。例如，多智能体微调（multi-agent finetuning）(Subramaniam et al., 2025) 利用从多智能体辩论中采样的高质量协作轨迹进行监督微调，实现 (1) 智能体的角色特定专业化，以及 (2) 底层主干模型推理能力的提升。类似地，Sirius (Zhao et al., 2025c) 与 MALT (Motwani et al., 2024) 采用自我对弈（self-play）收集高质量协作轨迹，并各自在其多智能体协作框架内训练智能体。虽然两种方法都在一定程度上利用失败轨迹，但方法论上有所不同：Sirius 仅依赖 SFT，并通过自我纠正将错误轨迹整合进训练数据集；MALT 则采用 DPO，自然地利用负样本。这些方法为多智能体系统自我改进的潜力提供了早期证据，尽管它们主要应用于相对简单的场景（如多智能体辩论或"生成器—验证器—回答器"系统）。更进一步，MaPoRL (Park et al., 2025) 引入任务特定的奖励塑形，通过强化学习显式激励智能体间的通信与合作。MARFT (Liao et al., 2025) 在传统多智能体强化学习（multi-agent reinforcement learning，MARL）与基于 LLM 的多智能体强化调优之间架起了一座综合性桥梁。在此基础上，MARTI (Liao et al., 2025) 提出了一个更可定制的强化多智能体微调框架，支持智能体结构与奖励函数的灵活设计。实证结果表明，LLM 主干在协作训练过程中其协作能力有显著提升。

**面向协作的优化（Collaboration-oriented Optimisation）。** 除推理之外，较小规模的工作聚焦于增强多智能体系统内的通信与协作能力。其核心假设是 LLM 智能体并非天生高效的团队成员，其协作沟通技能需要针对性训练。早期例子是 COPPER (Bo et al., 2024)，它采用 PPO 训练一个共享反思器（reflector），为多智能体协作轨迹生成高质量、角色感知的个性化反思。OPTIMA (Chen et al., 2025h) 更直接地针对多智能体系统的通信效率（以 token 使用量与通信可读性衡量），探索通过 SFT、DPO 及混合方法实现有效性—效率权衡。它报告在需要密集信息交换的任务上以不到 10% 的 token 成本实现了 2.8 倍的性能提升，生动展示了扩展智能体协作能力的巨大潜力。此外，MaPoRL (Park et al., 2025) 认为，对开箱即用的 LLM 进行提示并仅依赖其与生俱来的协作能力这一流行范式是值得商榷的。相反，它在多智能体辩论框架内引入精心设计的强化学习信号以显式激发协作行为，鼓励智能体更频繁、更高质量地进行通信。

## 6 特定领域优化（Domain-Specific Optimisation）

尽管前几节聚焦于通用场景下的智能体优化与进化技术，但特定领域智能体系统提出了独特的挑战，需要量身定制的优化策略。这些领域，如生物医学（Almansoori et al., 2025）、编程（Tang et al., 2024）、科学研究（Pu et al., 2025）、游戏（Belle et al., 2025）、计算机使用（Sun et al., 2025）以及金融与法律研究，往往以专门化的任务结构、领域知识库、不同的数据模态（data modality）和运行约束为特征。这些因素会显著影响智能体的设计、优化与进化方式。在本节中，我们综述特定领域智能体优化与进化的最新进展，重点介绍为满足各领域独特需求而开发的有效技术。

### 6.1 生物医学中的特定领域优化

在生物医学领域，智能体优化侧重于使智能体行为与真实临床场景的程序性和操作性要求保持一致。近期研究已在两个关键应用领域证明了特定领域智能体设计的有效性：医学诊断（medical diagnosis）（Donner-Banzhoff, 2018; Almansoori et al., 2025; Zhuang et al., 2025）和分子发现（molecular discovery）（M. Bran et al., 2024; Inoue et al., 2025）。下文我们考察这两个领域中具有代表性的智能体优化策略。

#### 6.1.1 医学诊断

医学诊断要求根据症状、病史和诊断检测结果等临床信息来确定患者的病情（Kononenko, 2001; Donner-Banzhoff, 2018）。近期研究越来越多地探索在此场景下使用自主智能体，使系统能够自动进行诊断对话、提出澄清性问题并生成合理的诊断假设（Li et al., 2024c; Chen et al., 2025i; Zuo et al., 2025; Ghezloo et al., 2025）。这些智能体通常在不确定条件下运行，基于不完整或模糊的患者信息做出决策（Chen et al., 2025i）。诊断过程通常涉及多轮交互，智能体在此过程中通过追问来获取缺失信息（Chen et al., 2025i）。此外，为支持稳健的临床推理，智能体通常需要整合外部知识库，或与专门的医学工具交互以进行信息检索和基于证据的推理（Feng et al., 2025b; Fallahpour et al., 2025）。

鉴于这些特定领域需求，近期研究集中于开发专门针对医学诊断优化的智能体架构（Li et al., 2024a; Almansoori et al., 2025; Ghezloo et al., 2025; Wang et al., 2025l）。一个有前景的研究方向聚焦于多智能体系统，该类系统在建模医学诊断所涉及的复杂性和多步推理方面展现出强大潜力。这些方法大致可分为两类：模拟驱动（simulation-driven）设计与协作式（collaborative）设计。模拟驱动系统旨在再现真实临床场景，为智能体分配特定角色，使其能够在模拟医疗环境中通过交互学习诊断策略。例如，MedAgentSim（Almansoori et al., 2025）引入了一个自我进化（self-evolving）模拟框架，整合经验回放（experience replay）、思维链集成（chain-of-thought ensembling）和基于 CLIP 的语义记忆来支持诊断推理。PathFinder（Ghezloo et al., 2025）针对组织病理学分析，通过编排多个智能体在十亿像素级医学图像上模拟专家诊断流程。相比之下，协作式多智能体系统侧重于智能体之间的集体决策与协作。例如，MDAgents（Kim et al., 2024）实现了多个智能体之间的自适应协作，其中仲裁智能体（moderator agent）负责整合多样化建议，并在需要时咨询外部知识源。MDTeamGPT（Chen et al., 2025c）将该范式扩展至多学科会诊，通过反思性讨论机制支持自我进化的、基于团队的诊断过程。

另一条面向诊断的智能体优化研究路线聚焦于工具整合与多模态推理。例如，MMedAgent（Li et al., 2024a）通过跨不同模态动态整合专门的医学工具，解决了现有多模态大语言模型（LLM）的泛化局限性。为提高临床可靠性，MedAgent-Pro（Wang et al., 2025l）引入了以既定临床标准为指导的诊断规划，并通过任务专用工具智能体整合多模态证据。与固定智能体架构不同，近期工作探索了根据诊断表现进行自适应的更灵活设计。例如，Zhuang et al.（2025）提出了一个基于图的智能体框架，其中推理过程利用诊断结果的反馈进行持续调整。这些方法凸显了专业化（specialisation）、多模态（multimodality）和交互式推理（interactive reasoning）作为开发医学诊断智能体系统的关键原则。

#### 6.1.2 分子发现与符号推理

生物医学领域的分子发现要求对化学结构、反应路径和药理约束进行精确的符号推理（symbolic reasoning）（Bilodeau et al., 2022; Makke and Chawla, 2024; M. Bran et al., 2024）。为支持分子发现，近期基于智能体的系统引入了量身定制的技术，例如整合化学分析工具、增强知识保持的记忆能力，以及实现多智能体协作（McNaughton et al., 2024; Inoue et al., 2025）。一个关键方法是特定领域工具整合，它使智能体能够通过与可执行的化学操作交互来进行化学推理。例如，CACTUS（McNaughton et al., 2024）为智能体配备了 RDKit（Landrum, 2013）等化学信息学工具，以确保生成化学上有效的输出。通过将推理锚定在特定领域工具集上，CACTUS 的性能显著优于未整合工具的智能体。类似地，LLM-RDF（M. Bran et al., 2024）通过协调专门智能体来自动化化学合成，每个智能体负责一项特定任务，并配备相应的工具用于文献挖掘、合成规划或反应优化。

另一条突出的研究路线利用记忆增强推理（memory-enabled reasoning）（Hu et al., 2025c; Inoue et al., 2025），智能体通过记录先前问题的求解方式来从过往经验中学习。ChemAgent（Tang et al., 2025a）将复杂的化学任务分解为较小的子任务，并将其存储在结构化记忆模块中，从而实现高效的检索与精炼。OSDA Agent（Hu et al., 2025c）通过引入自我反思机制扩展了这一方法，其中失败的分子提案被抽象为结构化的记忆更新，用以指导并增强未来的决策。与此同时，多智能体协调带来了额外的好处。DrugAgent（Inoue et al., 2025）引入了一种协调者架构，整合来自基于机器学习的预测器、生物医学知识图谱和文献检索智能体的证据。它采用思维链（Chain-of-Thought）和 ReAct（Yao et al., 2023b）框架来支持可解释的、多来源的推理。LIDDIA（Averly et al., 2025）通过分配模块化角色（即推理者、执行者、评估者和记忆）推广了这一设计，这些角色共同模拟药物化学中的迭代工作流，并促进多目标分子评估。

### 6.2 编程中的特定领域优化

在编程领域，智能体优化侧重于使智能体行为与成熟软件工程工作流的程序性和操作性要求保持一致。近期研究已在两个关键应用领域证明了特定领域智能体设计的有效性：代码精炼（code refinement）（Rasheed et al., 2024; Tang et al., 2024; Pan et al., 2025b）和代码调试（code debugging）（Lee et al., 2024a; Puvvadi et al., 2025; Adnan et al., 2025）。下文我们考察这两个领域中具有代表性的智能体优化策略。

#### 6.2.1 代码精炼

代码精炼涉及在保持原始功能的同时，迭代改进代码的质量、结构和正确性（Yang et al., 2024d; He et al., 2025; Islam et al., 2025）。近期研究越来越多地探索支持此类任务特定领域优化的智能体系统，重点放在自我改进、协作工作流以及与编程工具的整合上（Madaan et al., 2023; Tang et al., 2024; Rahman et al., 2025）。这些系统旨在模拟人在回路（human-in-the-loop）的精炼过程，强制遵循软件工程最佳实践，并确保代码在整个迭代开发周期中保持健壮、可读和可维护。一个关键的优化策略涉及自我反馈（self-feedback）机制，即智能体对其自身输出进行批判和修订。例如，Self-Refine（Madaan et al., 2023）引入了一个轻量级框架，其中语言模型对其自身输出生成自然语言反馈，并随后据此修订代码。类似地，CodeCriticBench（Zhang et al., 2025a）提出了一个综合性基准，用于评估大语言模型的自我批判与精炼能力，其中智能体通过结构化自然语言反馈来识别、解释和修订代码缺陷的能力受到评估。LLM-Surgeon（van der Ouderaa et al., 2023）提出了一个系统性框架，其中语言模型诊断自身代码输出中的结构和语义问题，并基于习得的修复模式进行针对性编辑，从而在保持功能的同时优化代码质量。这些方法无需针对特定任务重新训练，即可带来代码质量的一致改进。

另一条研究路线探索经验驱动学习（experience-driven learning），即智能体依靠记忆增强推理，系统性地记录并复用先前遇到任务的解决方案，从而提升其问题解决能力（Wang et al., 2025g; Tang et al., 2024; Pan et al., 2025b）。例如，AgentCoder（Huang et al., 2023a）和 CodeAgent（Tang et al., 2024）通过为各个智能体分配专门角色（如编码者、评审者和测试者）来模拟协作式开发工作流，并通过结构化对话循环迭代改进代码。这些系统支持集体评估与修订，促进角色专业化和深思熟虑的决策。此外，CodeCoR（Pan et al., 2025b）和 OpenHands（Wang et al., 2025g）等工具增强型框架整合了外部工具和模块化智能体交互，以促进动态代码裁剪、补丁生成和上下文感知的精炼。VFlow（Wei et al., 2025b）将 Verilog 代码生成任务的工作流优化问题重构为在基于代码表示的 LLM 节点图上的搜索任务，采用带过往经验协作进化的蒙特卡洛树搜索（Cooperative Evolution with Past Experience MCTS，CEPE-MCTS）算法。这些进展凸显了迭代反馈、模块化设计和交互式推理作为构建自适应代码精炼智能体系统的核心原则。

#### 6.2.2 代码调试

代码调试带来了复杂的挑战，需要精确的故障定位、执行感知推理和迭代修正。通用大语言模型通常缺乏这些能力（Puvvadi et al., 2025; Mannadiar and Vangheluwe, 2010）。为应对这些挑战，特定领域优化侧重于使智能体的角色和工作流与人类调试实践中观察到的结构化推理模式及工具使用方式保持一致。一个关键策略是利用运行时反馈来促进自我修正。例如，Self-Debugging（Chen et al., 2024c）和 Self-Edit（Zhang et al., 2023a）通过将执行轨迹纳入调试过程来体现这一方法。这些智能体通过故障识别、基于自然语言的推理和针对性代码修订的内部循环来运作，能够在无外部监督的情况下实现自主调试。

近期研究探索了专门支持调试工作流多阶段结构的模块化智能体架构。例如，PyCapsule（Adnan et al., 2025）在程序员智能体和执行者智能体之间引入了职责分离，从而将代码生成与语义验证区分开来。Self-Collaboration（Dong et al., 2024）和 RGD（Jin et al., 2024）等更先进的系统采用协作式流水线，其中智能体被分配测试者、评审者或反馈分析者等专门角色，以模拟专业调试实践。此外，FixAgent（Lee et al., 2024a）通过分层智能体激活（hierarchical agent activation）扩展了这一范式，根据缺陷复杂度和所需分析深度动态调度不同的智能体。

### 6.3 金融与法律研究中的特定领域优化

在金融和法律领域，智能体优化侧重于使多智能体架构、推理策略和工具整合适应特定领域工作流的程序性和操作性需求（Sun et al., 2024b; He et al., 2024; Li et al., 2025f）。近期研究已在两个关键应用领域证明了此类特定领域设计的有效性：金融决策（financial decision-making）（Li et al., 2023c; Yu et al., 2024b; Wang et al., 2024j）和法律推理（legal reasoning）（Di Martino et al., 2023; Chen et al., 2025a），其中模块化设计、协作交互和基于规则的推理（rule-grounded reasoning）对于可靠性能至关重要。下文我们考察这两个领域中具有代表性的智能体优化策略。

#### 6.3.1 金融决策

金融决策要求智能体在不确定且快速变化的环境中运行，对波动的市场动态进行推理，并整合数值指标、新闻情绪和专家知识等异构信息源（Li et al., 2023c; Sarin et al., 2024; Chudziak and Wawer, 2025）。为应对这些特定领域需求，近期研究集中于开发针对金融环境的程序性和认知性要求量身定制的多智能体架构（Fatemi and Hu, 2024; Luo et al., 2025b）。一个关键策略涉及概念化与协作式智能体设计。例如，FinCon（Yu et al., 2024b）提出了一个基于大语言模型的综合多智能体系统，采用概念言语强化（conceptual verbal reinforcement）和领域自适应微调来增强动态市场中的决策稳定性与策略一致性。PEER（Wang et al., 2024j）通过一个包含专家、检索者和控制者角色的模块化智能体架构扩展了这一范式，这些角色在统一的调优机制下交互，以平衡任务专门化与通用适应性。FinRobot（Yang et al., 2024b）通过整合外部工具实现基于模型的接地推理（model-grounded reasoning），使智能体能够将高层策略与可执行的金融模型及实时数据流连接起来，从而进一步推进了这一研究方向。

另一条面向金融决策的智能体优化研究路线聚焦于情绪分析与报告生成（Xing, 2025; Tian et al., 2025; Raza et al., 2025）。异构大语言模型智能体架构（Xing, 2025）通过将专门的情绪模块与基于规则的验证器相结合，确保符合领域特定准则，从而增强金融报告的稳健性。类似地，基于模板的报告框架（Tian et al., 2025）将报告生成分解为智能体驱动的检索、验证和综合阶段，并通过真实世界反馈实现迭代精炼。这些方法展示了自我进化多智能体系统在复杂金融环境中提供可靠、可解释且上下文感知的决策支持的潜力。

#### 6.3.2 法律推理

法律推理要求智能体解读结构化的法律规则、分析案件特定证据，并产生与制度法规和司法标准一致的输出（Xu and Ju, 2023; Yuan et al., 2024c; Jiang and Yang, 2025）。为满足这些特定领域需求，近期研究探索了针对法律场景的程序性和解释性要求量身定制的多智能体系统（Di Martino et al., 2023; Hu and Shu, 2023; Chen et al., 2025a）。一个重要方向涉及模拟司法程序并支持结构化论证的协作式智能体框架。例如，LawLuo（Sun et al., 2024b）引入了一种协同运行的多智能体架构，其中法律智能体被分配文档起草、法律论证生成和合规性验证等专门角色，所有角色均在中央控制器的监督下运行，以确保程序一致性和法律正确性。多智能体司法模拟（Multi-Agent Justice Simulation）（Di Martino et al., 2023）和 AgentCourt（Chen et al., 2025a）将这一范式扩展至对对抗性审判程序的建模，使智能体能够参与基于角色的交互，模拟真实法庭的运作动态。特别是，AgentCourt 融入了自我进化的律师智能体，这些智能体通过反思性自我对弈（reflective self-play）来精炼其策略，从而提升辩论质量和程序真实性。

另一条研究路线聚焦于结构化法律推理和领域接地可解释性（domain-grounded interpretability）。LegalGPT（Shi et al., 2024b）在多智能体系统中整合了法律思维链框架，通过可解释且与规则一致的步骤引导法律推理。类似地，AgentsCourt（He et al., 2024）将法庭辩论模拟与法律知识增强相结合，使智能体能够在成文规则和判例先例的基础上进行司法决策。这些方法凸显了规则接地（rule grounding）、模块化角色设计和协作推理在开发健壮、透明且法律上可靠的智能体系统中的重要性。

## 7 评估（Evaluation）

基于 LLM 的智能体迅速涌现，凸显了对严格、多维评估框架的需求。随着这些智能体被部署到日益多样化的任务与环境中，近期研究引入了一系列基准（benchmark）和方法论，不仅评估任务完成情况，还评估推理质量、泛化能力以及对安全性（safety）与对齐（alignment）标准的遵从。评估不再被视为静态的终点，而是一种动态反馈机制：细粒度的性能信号如今被用于指导智能体优化、提示词（prompt）精炼和数据集扩充，从而催生能够持续获取新能力并处理失败案例的自演化系统。当前的评估范式涵盖采用标准化指标的基准任务、面向安全性与对齐的审计，以及将大模型用作灵活、可扩展评估器的"LLM 作为裁判"（LLM-as-a-Judge）方法。

### 7.1 基于基准的评估（Benchmark-based Evaluation）

#### 7.1.1 工具与 API 驱动的智能体（Tool and API-Driven Agents）

工具增强型智能体根据其调用外部 API 和函数以解决超出其内在知识范围的问题的能力进行评估。ToolBench (Xu et al., 2023)、API-Bank (Li et al., 2023b)、MetaTool (Huang et al., 2023b) 和 ToolQA (Zhuang et al., 2023) 等基准定义了需要工具使用的任务，并同时评估 API 调用的正确性与效率。许多此类评估采用模拟 API 或沙箱（sandbox）环境，在衡量任务成功率的同时也衡量交互效率。早期研究表明，智能体往往会过拟合特定的工具模式（tool schema），对未曾见过的 API 泛化能力有限。为弥补这一局限，GTA (Wang et al., 2024b) 和 AppWorld (Trivedi et al., 2024) 等近期基准引入了更真实、需要跨多个工具进行规划与协调的多步任务，同时更加强调面向过程的评估指标。这一趋势反映了向更丰富、更注重推理的评估的总体转变：不仅评估最终结果，还评估决策过程的质量。

#### 7.1.2 网页导航与浏览智能体（Web Navigation and Browsing Agents）

Web 智能体根据其与网站交互、提取信息以及完成真实在线任务的能力进行评估。BrowseComp (Wei et al., 2025a)、MM-BrowseComp (Li et al., 2025e)、WebArena (Zhou et al., 2023b)、VisualWebArena (Koh et al., 2024)、WebCanvas (Pan et al., 2024b)、WebWalker (Wu et al., 2025b) 和 AgentBench (Liu et al., 2023a) 等基准逐步提升了 Web 评估的真实性与多样性，涵盖模拟环境与实时环境。这些基准测试导航技能、对界面变化的适应性，以及文本与视觉信息的整合能力。近期工作纳入了中间指标（如子目标完成情况）和鲁棒性（robustness）评估，不过由于 Web 的动态特性，可复现性与泛化性仍具挑战性。

#### 7.1.3 多智能体协作与通用智能体（Multi-Agent Collaboration and Generalists）

随着智能体日益通用化，新的基准开始面向多智能体协调与跨领域能力。MultiAgentBench (Zhu et al., 2025) 和 SwarmBench (Ruan et al., 2025) 评估 LLM 智能体之间的协作、竞争与去中心化协调，既评估任务完成情况，也评估沟通与策略的质量。GAIA (Mialon et al., 2023) 和 AgentBench (Liu et al., 2023a) 等通用型基准测试智能体在从网页导航到编程、数据库查询等多样环境中的适应性。近期工作 Wang et al. (2025b) 进一步探索了 GAIA 基准，以分析智能体系统中效率与效果的权衡，提出了 Efficient Agents——一个以显著更低的运行成本实现具有竞争力性能的框架。这些评估凸显了在异构任务之间聚合指标的挑战、对狭窄场景过拟合的风险，以及建立统一、整体化排行榜（leaderboard）的需求。

#### 7.1.4 GUI 与多模态环境智能体（GUI and Multimodal Environment Agents）

GUI 与多模态基准挑战智能体在结合文本与视觉输入的丰富交互式环境中运作。Mobile-Bench (Deng et al., 2024)、AndroidWorld (Rawles et al., 2024)、CRAB (Xu et al., 2024a)、GUI-World (Chen et al., 2024a) 和 OSWorld (Xie et al., 2024) 模拟真实的应用程序与操作系统，要求复杂的动作序列。任务往往结合自然语言理解、视觉感知与 API 调用。评估衡量任务成功率、状态管理、感知精度以及对 GUI 变化的适应性。然而，GUI 环境的多样性使得标准化与可复现性变得困难，智能体在面对界面变化时仍然脆弱。

#### 7.1.5 领域专用任务智能体（Domain-Specific Task Agents）

编程（SWE-bench (Jimenez et al., 2024)）、数据科学（DataSciBench (Zhang et al., 2025c)、MLGym (Nathani et al., 2025)）、企业生产力（WorkBench (Styles et al., 2024)）和科学研究（OpenAGI (Ge et al., 2023)、SUPER (Bogin et al., 2024)）等领域的专注基准，评估整合了规划、工具使用与领域规范遵循的专业能力。例如，SWE-bench 在真实 GitHub 仓库上评估代码编辑智能体，而 AgentClinic (Schmidgall et al., 2024) 和 MMedAgent (Li et al., 2024a) 则测试临床场景中的多模态推理。评估标准已从二元成功度量扩展为涵盖测试通过率、策略遵从性以及领域特定约束符合性等指标。尽管取得上述进展，指标定义的不一致与泛化方面的持续缺口仍是重大挑战。

### 7.2 基于 LLM 的评估（LLM-based Evaluation）

#### 7.2.1 LLM 作为裁判（LLM-as-a-Judge）

"LLM 作为裁判"范式是指利用大语言模型，通过结构化提示词来评估 AI 系统输出（如文本、代码或对话回复）的质量 (Arabzadeh et al., 2024; Li et al., 2024b; Qian et al., 2025b)。该方法作为传统评估方式——包括人工评判以及 BLEU、ROUGE 等自动指标，后者往往无法捕捉语义深度或连贯性——的可扩展且高性价比替代方案而备受关注 (Arabzadeh et al., 2024)。LLM 裁判通常以两种模式运行：点式评估（pointwise evaluation）(Ruan et al., 2024)，即直接依据事实性、有用性等标准对输出打分；以及成对比较（pairwise comparison），即比较两个输出并给出理由选择更优者 (Li et al., 2024b; Zhao et al., 2025b)。

近期研究表明，基于 LLM 的评估可与人工评判相关联，在某些情况下达到与标注者间一致性（inter-annotator agreement）水平相当的程度 (Arabzadeh et al., 2024)。然而，这些方法对提示词设计敏感，且易受细微指令变化引入的偏差影响 (Arabzadeh et al., 2024; Zhao et al., 2025b)。此外，单步、面向输出的评估可能忽视多步过程中的推理深度 (Zhuge et al., 2024b; Wang et al., 2025h)。为解决这些局限，研究者提出了多种增强方案，包括 CollabEval (Qian et al., 2025b) 等多智能体协商框架，以及用于校准并提升 LLM 裁判可靠性的结构化元评估（meta-evaluation）基准 (Li et al., 2024b; Zhao et al., 2025b)。

#### 7.2.2 智能体作为裁判（Agent-as-a-Judge）

"智能体作为裁判"框架扩展了基于 LLM 的评估，采用具备多步推理、状态管理和工具使用能力的完整智能体系统来评判其他 AI 智能体 (Zhuge et al., 2024b; Zhao et al., 2025b; Qian et al., 2025b)。与传统 LLM 裁判只关注最终输出不同，智能体裁判评估整个推理轨迹，捕捉决策过程与中间动作 (Zhuge et al., 2024b)。例如，Zhuge et al. (2024b) 将智能体裁判应用于面向代码生成智能体的 DevAI 基准。该框架纳入专门模块来分析中间产物、构建推理图并验证分层需求，其评估结果比传统基于 LLM 的方法更接近人类专家判断。智能体裁判还带来了显著的效率提升，与人工审查相比降低了评估时间和成本 (Zhuge et al., 2024b; Zhao et al., 2025b)。

尽管如此，实施"智能体作为裁判"方法引入了额外的复杂性，并对其泛化到代码生成以外的领域提出挑战。当前研究致力于提升适应性并简化其在更广泛 AI 任务中的部署 (Zhao et al., 2025b; Qian et al., 2025b)。

### 7.3 终身自演化智能体中的安全性、对齐与鲁棒性（Safety, Alignment, and Robustness in Lifelong Self-Evolving Agents）

在自演化 AI 智能体三定律（Three Laws of Self-Evolving AI Agents）的语境下，Endure（存续）——即任何修改过程中对安全性与稳定性的维护——构成了对所有其他形式适配的首要约束。对于终身、自演化的智能体系统而言，安全性不是一次性的认证，而是一项持续性的要求：每一次演化步骤，从提示词更新到拓扑结构变更，都必须评估其是否引发意外或恶意行为。这要求评估协议具备连续性（continuous）、细粒度（granular）和可扩展性（scalable），确保智能体在长期适应过程中始终保持对齐。

近期工作引入了多种评估范式。面向风险的基准如 AgentHarm (Andriushchenko et al., 2025) 衡量智能体遵从明确恶意多步请求的倾向——这些请求需要连贯的工具使用来执行欺诈、网络犯罪等有害目标，结果揭示即使是领先的 LLM 也能在极少的提示诱导下被引导实施复杂的不安全行为。领域专用探针如 RedCode (Guo et al., 2024a)（代码安全）和 MobileSafetyBench (Lee et al., 2024c)（移动端控制）在真实、沙箱化的环境中对智能体进行压力测试。MACHIAVELLI (Pan et al., 2023) 等行为探针探索智能体是否会在奖励优化下发展出不道德、追逐权力的策略，凸显了 Endure 与 Excel 之间的相互作用——安全适配不得削弱核心任务能力。

元评估方法，如 Agent-as-a-Judge (Zhuge et al., 2024b)、AgentEval (Arabzadeh et al., 2024) 和 R-Judge (Yuan et al., 2024b)，将 LLM 智能体本身定位为评估者或安全监控器，提供了可扩展的监督，但也暴露了当前"风险意识"的局限。这些研究强调了安全性的多维本质，仅靠准确性是不够的；对正确性指标的过度依赖可能掩盖认识论风险与系统性偏差 (Li et al., 2025j)。SafeLawBench (Cao et al., 2025) 等法律对齐测试进一步表明，即使是最先进的模型也难以满足既定的法律原则，反映出在具有开放式措辞规范（open-textured norms）的领域中将对齐进行编码的难度。

尽管取得这些进展，大多数当前评估仍是基于快照的（snapshot-based），只在单一时间点评估智能体。对于 MASE（多智能体自主演化，Multi-Agent Self-Evolving）系统，安全性评估本身必须变得动态——随着系统演化持续监控、诊断和纠正行为。开发跨智能体生态系统全生命周期追踪安全性、对齐与鲁棒性的纵向（longitudinal）、感知演化的基准，仍是一项紧迫的开放挑战。

## 8 挑战与未来方向（Challenges and Future Directions）

尽管进展迅速，AI 智能体的演化与优化仍面临根本性障碍。这些挑战与自演化 AI 智能体三定律密切相关，必须加以解决才能实现终身智能体系统的愿景。我们据此对关键开放问题进行归类。

### 8.1 挑战（Challenges）

#### 8.1.1 Endure——安全适配（Safety Adaptation）

(1) 安全性、监管与对齐。大多数优化管线优先考虑任务指标而非安全约束，忽视了意外行为、隐私泄露和目标错位等风险。演化智能体的动态特性削弱了现有法律框架（如欧盟《人工智能法案》EU AI Act、GDPR）的有效性，因为这些框架假设模型是静态的、决策逻辑是固定的。这要求建立新的演化感知审计机制、自适应许可、可证明安全的沙箱（provable-safety sandboxes），以及能够追踪并约束智能体自主演化路径的法律协议。

(2) 奖励建模与优化不稳定性。针对中间推理步骤学习的奖励模型（reward model）常常面临数据稀缺、监督含噪和反馈不一致的问题，导致智能体行为不稳定或发散。稳定性是安全性的核心：即使输入或更新规则中的微小扰动，也可能破坏演化工作流的可信度。

#### 8.1.2 Excel——性能保持（Performance Preservation）

(1) 科学与领域专用场景中的评估。在生物医学、法律等领域，可靠的真值（ground truth）往往缺失或存在争议，使构建可信的优化反馈信号变得复杂。

(2) 多智能体系统优化中效率与效果的平衡。大规模多智能体优化能提升任务性能，但会带来巨大的计算成本、延迟和不稳定性。设计显式权衡效果与效率的方法仍未解决。

(3) 优化后提示词与拓扑结构的可迁移性。优化后的提示词或智能体拓扑结构往往脆弱，在推理能力不同的 LLM 主干（backbone）之间泛化不佳。这削弱了生产环境中的可扩展性与可复用性。

#### 8.1.3 Evolve——自主优化（Autonomous Optimisation）

(1) 多模态与空间环境中的优化。大多数优化算法仅支持文本，而真实世界的智能体必须处理多模态输入，并在空间具身或连续环境中进行推理。这需要内部世界模型以及感知—时间推理能力。

(2) 工具使用与工具创造。当前方法通常假设固定的工具集，忽视了工具随智能体一同自主发现、适配和协同演化。

### 8.2 未来方向（Future Directions）

展望未来，上述许多局限都指向有前景的研究方向。我们重点列出若干方向，并将其与在 MOP（模型离线预训练，Model Offline Pretraining）→MOA（模型在线适配，Model Online Adaptation）→MAO（多智能体编排，Multi-Agent Orchestration）→MASE（多智能体自主演化，Multi-Agent Self-Evolving）范式转变中的作用相关联。

(1) 面向完全自主自演化的模拟环境（MASE）。开发开放式、交互式的模拟平台，使智能体能够迭代交互、接收反馈，并通过闭环优化精炼提示词、记忆、工具和工作流。

(2) 推进工具使用与工具创造（MAO→MASE）。从静态工具调用转向智能体自适应地选择、组合或创造工具。纳入强化学习与反馈驱动策略，并配套稳健的评估管线。

(3) 真实世界评估与基准测试（跨阶段）。创建反映真实世界复杂性的基准与协议，支持基于交互的、纵向的评估，并与长期改进信号对齐。

(4) 多智能体系统优化中的效果—效率权衡（MAO）。设计联合建模性能与资源约束的优化算法，使多智能体系统能在严格的延迟、成本或能耗预算下部署。

(5) 面向科学与专业应用的领域感知演化（MASE）。针对科学、医学、法律或教育中的领域特定约束定制演化方法，整合异构知识源、定制化评估标准与监管合规要求。

展望。解决这些挑战需要优化管线不仅高性能、领域自适应，还要安全、监管感知且可持续。将这些解决方案嵌入 MOP→MOA→MAO→MASE 演进轨迹，并以自演化 AI 智能体三定律为基础，为真正的终身、自主智能体系统——能够在整个运行生命周期内存续（endure）、卓越（excel）与演化（evolve）的系统——提供了连贯的路线图。

## 9 结论（Conclusions）

在本综述中，我们对自演化 AI 智能体这一新兴范式进行了全面概述，它弥合了基础模型的静态能力与终身智能体系统所需的持续适应性之间的鸿沟。我们将这种演化置于统一的四阶段轨迹中：从模型离线预训练（Model Offline Pretraining, MOP）与模型在线适配（Model Online Adaptation, MOA），经由多智能体编排（Multi-Agent Orchestration, MAO），最终到多智能体自主演化（Multi-Agent Self-Evolving, MASE），凸显了从静态、人工配置的模型向动态、自主生态系统的渐进转变。

为使这一转变形式化，我们引入了一个概念框架来抽象智能体演化背后的反馈回路，包含四个关键组件：输入（Inputs）、智能体系统（Agent System）、目标（Objectives）与优化器（Optimisers），它们共同决定了智能体如何通过与环境的持续交互来改进。在此基础上，我们系统性地综述了跨智能体组件的优化技术、领域专用策略，以及构建自适应、有韧性的智能体系统所必需的评估方法论。

我们还提出了自演化 AI 智能体三定律——Endure（存续，即安全适配）、Excel（卓越，即性能保持）与 Evolve（演化，即自主演化）——作为指导原则，以确保终身自我改进保持安全、有效且对齐。这些定律不仅仅是原则，更是实用的设计约束，确保通往自主性的道路始终与安全性、性能与适应性保持一致。它们是 MASE 范式的护栏，引导研究从狭窄的、单次性的优化走向持续的、开放式的自我改进。

展望未来，存续、卓越与演化的能力对于在动态真实环境中运作的智能体将具有决定性意义，无论是科学发现、软件工程还是人机协作。实现这一目标需要可扩展优化算法、终身评估协议、异构智能体环境中的安全协调，以及适应未知领域机制等方面的突破。我们希望本综述既能作为参考点，也能作为行动号召，构建一个自演化 AI 智能体生态系统——它们不仅仅是执行任务，而是生存、学习并长久存续。通过将技术创新与有原则的自演化相结合，我们可以为真正自主、有韧性且值得信赖的终身智能体系统铺平道路。

## 致谢（Acknowledgements）

我们感谢 Shuyu Guo 在智能体优化的早期探索与文献综述方面做出的宝贵贡献。

## 参考文献（References，保留英文原文）

References
Muntasir Adnan, Zhiwei Xu, and Carlos CN Kuhn. Large language model guided self-debugging code generation.arXiv
preprint arXiv:2502.02928, 2025.
Eshaan Agarwal, Joykirat Singh, Vivek Dani, Raghav Magazine, Tanuja Ganu, and Akshay Nambi. Promptwizard:
Task-aware prompt optimization framework.arXiv preprint arXiv:2405.18369, 2024.
Keivan Alizadeh, Seyed-Iman Mirzadeh, Dmitry Belenko, S. Khatamifard, Minsik Cho, Carlo C. del Mundo, Mohammad
Rastegari, and Mehrdad Farajtabar.LLM in a flash: Efficient large language model inference with limited memory. In
Proceedings of the 62nd Annual Meeting of the Association for Computational Linguistics (Volume 1: Long Papers),
pages 12562–12584, 2024.
Mohammad Almansoori, Komal Kumar, and Hisham Cholakkal. Self-evolving multi-agent simulations for realistic
clinical interactions. arXiv preprint arXiv:2503.22678, 2025.
Maksym Andriushchenko, Alexandra Souly, Mateusz Dziemian, Derek Duenas, Maxwell Lin, Justin Wang, Dan Hendrycks,
Andy Zou, J. Zico Kolter, Matt Fredrikson, Yarin Gal, and Xander Davies.AgentHarm: A benchmark for measuring
harmfulness of LLM agents. InThe Thirteenth International Conference on Learning Representations, 2025.
Negar Arabzadeh, Julia Kiseleva, Qingyun Wu, Chi Wang, Ahmed Awadallah, Victor Dibia, Adam Fourney, and Charles
Clarke. Towards better human-agent alignment: Assessing task utility in llm-powered applications.arXiv preprint
arXiv:2402.09015, 2024.
34

Derek Austin and Elliott Chartock.GRAD-SUM: Leveraging gradient summarization for optimal prompt engineering.
arXiv preprint arXiv:2407.12865, 2024.
Reza Averly, Frazier N Baker, and Xia Ning.LIDDIA: Language-based intelligent drug discovery agent.arXiv preprint
arXiv:2502.13959, 2025.
Nikolas Belle, Dakota Barnes, Alfonso Amayuelas, Ivan Bercovich, Xin Eric Wang, and William Wang. Agents of change:
Self-evolving llm agents for strategic planning.arXiv preprint arXiv:2506.04651, 2025.
Maciej Besta, Nils Blach, Ales Kubicek, Robert Gerstenberger, Michal Podstawski, Lukas Gianinazzi, Joanna Gajda,
Tomasz Lehmann, Hubert Niewiadomski, Piotr Nyczyk, et al. Graph of thoughts: Solving elaborate problems with
large language models. InProceedings of the AAAI conference on artificial intelligence, pages 17682–17690, 2024.
Zhenni Bi, Kai Han, Chuanjian Liu, Yehui Tang, and Yunhe Wang. Forest-of-thought: Scaling test-time compute for
enhancing LLM reasoning. InForty-second International Conference on Machine Learning, 2025.
Camille Bilodeau, Wengong Jin, Tommi Jaakkola, Regina Barzilay, and Klavs F Jensen. Generative models for molecular
discovery: Recent advances and challenges.Wiley Interdisciplinary Reviews: Computational Molecular Science, 12(5):
e1608, 2022.
Xiaohe Bo, Zeyu Zhang, Quanyu Dai, Xueyang Feng, Lei Wang, Rui Li, Xu Chen, and Ji-Rong Wen. Reflective
multi-agent collaboration based on large language models.Advances in Neural Information Processing Systems, 37:
138595–138631, 2024.
Ben Bogin, Kejuan Yang, Shashank Gupta, Kyle Richardson, Erin Bransom, Peter Clark, Ashish Sabharwal, and Tushar
Khot. SUPER: evaluating agents on setting up and executing tasks from research repositories. InProceedings of the
2024 Conference on Empirical Methods in Natural Language Processing, pages 12622–12645, 2024.
Tianle Cai, Xuezhi Wang, Tengyu Ma, Xinyun Chen, and Denny Zhou. Large language models as tool makers. InThe
Twelfth International Conference on Learning Representations, 2024.
CAMEL-AI. Workforce — camel-ai documentation.https://docs.camel-ai.org/key_modules/workforce, 2025. Accessed:
2025-08-09.
Chuxue Cao, Han Zhu, Jiaming Ji, Qichao Sun, Zhenghao Zhu, Yinyu Wu, Josef Dai, Yaodong Yang, Sirui Han, and
Yike Guo. SafeLawBench: Towards safe alignment of large language models. InFindings of the Association for
Computational Linguistics, pages 14015–14048, 2025.
Nicola De Cao, Wilker Aziz, and Ivan Titov. Editing factual knowledge in language models. InProceedings of the 2021
Conference on Empirical Methods in Natural Language Processing, pages 6491–6506, 2021.
Shuyang Cao and Lu Wang.AWESOME: GPU memory-constrained long document summarization using memory
mechanism and global salient content. InProceedings of the 2024 Conference of the North American Chapter of the
Association for Computational Linguistics: Human Language Technologies (Volume 1: Long Papers), pages 5925–5941,
2024.
Edward Y Chang. Socrasynth: Multi-llm reasoning with conditional statistics.arXiv preprint arXiv:2402.06634, 2024.
GaoWei Chang and Agent Network Protocol Contributors. Agent Network Protocol (ANP).https://github.com/
agent-network-protocol/AgentNetworkProtocol. MIT License, accessed 2025-07-31.
Bei Chen, Fengji Zhang, Anh Nguyen, Daoguang Zan, Zeqi Lin, Jian-Guang Lou, and Weizhu Chen.CodeT: Code
generation with generated tests. InThe Eleventh International Conference on Learning Representations, 2023.
Dongping Chen, Yue Huang, Siyuan Wu, Jingyu Tang, Huichi Zhou, Qihui Zhang, Zhigang He, Yilin Bai, Chujie Gao,
Liuyi Chen, et al.GUI-world: A video benchmark and dataset for multimodalGUI-oriented understanding. InThe
Thirteenth International Conference on Learning Representations, 2024a.
Guangyao Chen, Siwei Dong, Yu Shu, Ge Zhang, Jaward Sesay, Börje Karlsson, Jie Fu, and Yemin Shi.AutoAgents:
A framework for automatic agent generation. InProceedings of the Thirty-Third International Joint Conference on
Artificial Intelligence, pages 22–30, 2024b.
Guhong Chen, Liyang Fan, Zihan Gong, Nan Xie, Zixuan Li, Ziqiang Liu, Chengming Li, Qiang Qu, Hamid Alinejad-
Rokny, Shiwen Ni, and Min Yang.AgentCourt: Simulating court with adversarial evolvable lawyer agents. InFindings
of the Association for Computational Linguistics, pages 5850–5865. Association for Computational Linguistics, 2025a.
Guoxin Chen, Zhong Zhang, Xin Cong, Fangda Guo, Yesai Wu, Yankai Lin, Wenzheng Feng, and Yasheng Wang. Learning
evolving tools for large language models. InThe Thirteenth International Conference on Learning Representations,
2025b.
35

Kai Chen, Xinfeng Li, Tianpei Yang, Hewei Wang, Wei Dong, and Yang Gao.MDTeamGPT: A self-evolving llm-based
multi-agent framework for multi-disciplinary team medical consultation.arXiv preprint arXiv:2503.13856, 2025c.
Mingda Chen, Yang Li, Karthik Padthe, Rulin Shao, Alicia Yi Sun, Luke Zettlemoyer, Gargi Ghosh, and Wen-tau Yih.
Improving factuality with explicit working memory. InProceedings of the 63rd Annual Meeting of the Association for
Computational Linguistics (Volume 1: Long Papers), pages 11199–11213, 2025d.
Mingyang Chen, Haoze Sun, Tianpeng Li, Fan Yang, Hao Liang, KeerLu, Bin CUI, Wentao Zhang, Zenan Zhou, and
Weipeng Chen. Facilitating multi-turn function calling for LLMs via compositional instruction tuning. InThe
Thirteenth International Conference on Learning Representations, 2025e.
Nuo Chen, Hongguang Li, Jianhui Chang, Juhua Huang, Baoyuan Wang, and Jia Li. Compress to impress: Unleashing
the potential of compressive memory in real-world long-term conversations. InProceedings of the 31st International
Conference on Computational Linguistics, pages 755–773, 2025f.
Weize Chen, Ziming You, Ran Li, Yitong Guan, Chen Qian, Chenyang Zhao, Cheng Yang, Ruobing Xie, Zhiyuan Liu,
and Maosong Sun. Internet of agents: Weaving a web of heterogeneous agents for collaborative intelligence. InThe
Thirteenth International Conference on Learning Representations, 2025g.
Weize Chen, Jiarui Yuan, Chen Qian, Cheng Yang, Zhiyuan Liu, and Maosong Sun. Optima: Optimizing effectiveness
and efficiency for llm-based multi-agent system. InFindings of the Association for Computational Linguistics, pages
11534–11557. Association for Computational Linguistics, 2025h.
Xi Chen, Huahui Yi, Mingke You, WeiZhi Liu, Li Wang, Hairui Li, Xue Zhang, Yingman Guo, Lei Fan, Gang Chen,
et al. Enhancing diagnostic capability with multi-agents conversational large language models.NPJ digital medicine,
8(1):159, 2025i.
Xinyun Chen, Maxwell Lin, Nathanael Schärli, and Denny Zhou. Teaching large language models toSelf-Debug. In The
Twelfth International Conference on Learning Representations, 2024c.
Yuyang Cheng, Yumiao Xu, Chaojia Yu, and Yong Zhao.HAWK: A hierarchical workflow framework for multi-agent
collaboration. arXiv preprint arXiv:2507.04067, 2025.
Prateek Chhikara, Dev Khant, Saket Aryan, Taranjeet Singh, and Deshraj Yadav. Mem0: Building production-ready ai
agents with scalable long-term memory.arXiv preprint arXiv:2504.19413, 2025.
Jarosław A Chudziak and Michał Wawer.ElliottAgents: a natural language-driven multi-agent system for stock market
analysis and prediction.arXiv preprint arXiv:2507.03435, 2025.
Mingkai Deng, Jianyu Wang, Cheng-Ping Hsieh, Yihan Wang, Han Guo, Tianmin Shu, Meng Song, Eric P. Xing, and
Zhiting Hu. RLPrompt: Optimizing discrete text prompts with reinforcement learning. InProceedings of the 2022
Conference on Empirical Methods in Natural Language Processing, pages 3369–3391, 2022.
Shihan Deng, Weikai Xu, Hongda Sun, Wei Liu, Tao Tan, Jianfeng Liu, Ang Li, Jian Luan, Bin Wang, Rui Yan, and
Shuo Shang.Mobile-Bench: An evaluation benchmark for llm-based mobile agents. InProceedings of the 62nd Annual
Meeting of the Association for Computational Linguistics (Volume 1: Long Papers), pages 8813–8831, 2024.
Beniamino Di Martino, Antonio Esposito, and Luigi Colucci Cante. Multi agents simulation of justice trials to support
control management and reduction of civil trials duration.Journal of Ambient Intelligence and Humanized Computing,
14(4):3645–3657, 2023.
Guanting Dong, Yifei Chen, Xiaoxi Li, Jiajie Jin, Hongjin Qian, Yutao Zhu, Hangyu Mao, Guorui Zhou, Zhicheng Dou,
and Ji-Rong Wen.Tool-Star: Empowering llm-brained multi-tool reasoner via reinforcement learning.arXiv preprint
arXiv:2505.16410, 2025a.
Guanting Dong, Hangyu Mao, Kai Ma, Licheng Bao, Yifei Chen, Zhongyuan Wang, Zhongxia Chen, Jiazhen Du, Huiyang
Wang, Fuzheng Zhang, et al. Agentic reinforced policy optimization.arXiv preprint arXiv:2507.19849, 2025b.
Yihong Dong, Xue Jiang, Zhi Jin, and Ge Li. Self-collaboration code generation via chatgpt.ACM Transactions on
Software Engineering and Methodology, 33(7):1–38, 2024.
Norbert Donner-Banzhoff. Solving the diagnostic challenge: a patient-centered approach.The Annals of Family Medicine,
16(4):353–358, 2018.
Yiming Du, Wenyu Huang, Danna Zheng, Zhaowei Wang, Sebastien Montella, Mirella Lapata, Kam-Fai Wong, and Jeff Z
Pan. Rethinking memory in ai: Taxonomy, operations, topics, and future directions.arXiv preprint arXiv:2505.00675,
2025.
36

Yu Du, Fangyun Wei, and Hongyang Zhang.AnyTool: Self-reflective, hierarchical agents for large-scaleAPI calls. In
Forty-first International Conference on Machine Learning, 2024.
Sefika Efeoglu and Adrian Paschke. Retrieval-augmented generation-based relation extraction. arXiv preprint
arXiv:2404.13397, 2024.
Sugyeong Eo, Hyeonseok Moon, Evelyn Hayoon Zi, Chanjun Park, and Heuiseok Lim. Debate only when necessary:
Adaptive multiagent collaboration for efficient llm reasoning.arXiv preprint arXiv:2504.05047, 2025.
Adibvafa Fallahpour, Jun Ma, Alif Munim, Hongwei Lyu, and Bo Wang. Medrax: Medical reasoning agent for chest
x-ray. arXiv preprint arXiv:2502.02673, 2025.
Wei Fang, Yang Zhang, Kaizhi Qian, James Glass, and Yada Zhu. Play2prompt: Zero-shot tool instruction optimization
for llm agents via tool play.arXiv preprint arXiv:2503.14432, 2025.
Sorouralsadat Fatemi and Yuheng Hu. Finvision: A multi-agent framework for stock market prediction. InProceedings
of the 5th ACM International Conference on AI in Finance, pages 582–590, 2024.
Xiang Fei, Xiawu Zheng, and Hao Feng.MCP-Zero: Active tool discovery for autonomous llm agents.arXiv preprint
arXiv:2506.01056, 2025.
Jiazhan Feng, Shijue Huang, Xingwei Qu, Ge Zhang, Yujia Qin, Baoquan Zhong, Chengquan Jiang, Jinxin Chi, and
Wanjun Zhong. Retool: Reinforcement learning for strategic tool use in llms.arXiv preprint arXiv:2504.11536, 2025a.
Jinghao Feng, Qiaoyu Zheng, Chaoyi Wu, Ziheng Zhao, Ya Zhang, Yanfeng Wang, and Weidi Xie. M3builder: A
multi-agent system for automated machine learning in medical imaging.arXiv preprint arXiv:2502.20301, 2025b.
Chrisantha Fernando, Dylan Banarse, Henryk Michalewski, Simon Osindero, and Tim Rocktäschel. Promptbreeder:
Self-referential self-improvement via prompt evolution. InForty-first International Conference on Machine Learning,
2024.
Emily First, Markus N Rabe, Talia Ringer, and Yuriy Brun. Baldur: Whole-proof generation and repair with large
language models. InProceedings of the 31st ACM Joint European Software Engineering Conference and Symposium
on the Foundations of Software Engineering, pages 1229–1241, 2023.
Adam Fourney, Gagan Bansal, Hussein Mozannar, Cheng Tan, Eduardo Salinas, Friederike Niedtner, Grace Proebsting,
Griffin Bassman, Jack Gerrits, Jacob Alber, et al. Magentic-one: A generalist multi-agent system for solving complex
tasks. arXiv preprint arXiv:2411.04468, 2024.
Hongcheng Gao, Yue Liu, Yufei He, Longxu Dou, Chao Du, Zhijie Deng, Bryan Hooi, Min Lin, and Tianyu Pang.
FlowReasoner: Reinforcing query-level meta-agents.arXiv preprint arXiv:2504.15257, 2025a.
Huan-ang Gao, Jiayi Geng, Wenyue Hua, Mengkang Hu, Xinzhe Juan, Hongzhang Liu, Shilong Liu, Jiahao Qiu, Xuan
Qi, Yiran Wu, et al. A survey of self-evolving agents: On path to artificial super intelligence.arXiv preprint
arXiv:2507.21046, 2025b.
Shen Gao, Zhengliang Shi, Minghang Zhu, Bowen Fang, Xin Xin, Pengjie Ren, Zhumin Chen, Jun Ma, and Zhaochun
Ren. Confucius: Iterative tool learning from introspection feedback by easy-to-difficult curriculum. InProceedings of
the AAAI Conference on Artificial Intelligence, pages 18030–18038, 2024a.
Yunfan Gao, Yun Xiong, Yijie Zhong, Yuxi Bi, Ming Xue, and Haofen Wang. SynergizingRAG and reasoning: A
systematic review. arXiv preprint arXiv:2504.15909, 2025c.
Zhi Gao, Yuntao Du, Xintong Zhang, Xiaojian Ma, Wenjuan Han, Song-Chun Zhu, and Qing Li.CLOVA:A closed-loop
visual assistant with tool usage and update. InIEEE/CVF Conference on Computer Vision and Pattern Recognition,
pages 13258–13268. IEEE, 2024b.
Zhi Gao, Bofei Zhang, Pengxiang Li, Xiaojian Ma, Tao Yuan, Yue Fan, Yuwei Wu, Yunde Jia, Song-Chun Zhu, and Qing
Li. Multi-modal agent tuning: Building a vlm-driven agent for efficient tool usage. InThe Thirteenth International
Conference on Learning Representations, 2025d.
Yingqiang Ge, Wenyue Hua, Kai Mei, Juntao Tan, Shuyuan Xu, Zelong Li, Yongfeng Zhang, et al.OpenAGI: When llm
meets domain experts.Advances in Neural Information Processing Systems, 36:5539–5568, 2023.
Caleb Geren, Amanda Board, Gaby G. Dagher, Tim Andersen, and Jun Zhuang. Blockchain for large language model
security and safety: A holisticsurvey.SIGKDD Explorations, 26(2):1–20, 2024.
37

Fatemeh Ghezloo, Mehmet Saygin Seyfioglu, Rustin Soraki, Wisdom O Ikezogwo, Beibin Li, Tejoram Vivekanandan,
Joann G Elmore, Ranjay Krishna, and Linda Shapiro. Pathfinder: A multi-modal multi-agent system for medical
diagnostic decision-making applied to histopathology.arXiv preprint arXiv:2502.08916, 2025.
Anna Goldie, Azalia Mirhoseini, Hao Zhou, Irene Cai, and Christopher D.Manning Manning. Synthetic data generation
& multi-step RL for reasoning & tool use.arXiv preprint arXiv:2504.04736, 2025.
Zhibin Gou, Zhihong Shao, Yeyun Gong, Yelong Shen, Yujiu Yang, Minlie Huang, Nan Duan, and Weizhu Chen.ToRA:
A tool-integrated reasoning agent for mathematical problem solving. InThe Twelfth International Conference on
Learning Representations, 2024.
Aaron Grattafiori, Abhimanyu Dubey, Abhinav Jauhri, Abhinav Pandey, Abhishek Kadian, Ahmad Al-Dahle, Aiesha Let-
man, Akhil Mathur, Alan Schelten, Alex Vaughan, et al. The llama 3 herd of models.arXiv preprint arXiv:2407.21783,
2024.
Zhouhong Gu, Xiaoxuan Zhu, Yin Cai, Hao Shen, Xingzhou Chen, Qingyi Wang, Jialin Li, Xiaoran Shi, Haoran Guo,
Wenxuan Huang, et al.AgentGroupChat-V2: Divide-and-conquer is what llm-based multi-agent system need.arXiv
preprint arXiv:2506.15451, 2025.
Chengquan Guo, Xun Liu, Chulin Xie, Andy Zhou, Yi Zeng, Zinan Lin, Dawn Song, and Bo Li. Redcode: Risky
code execution and generation benchmark for code agents.Advances in Neural Information Processing Systems, 37:
106190–106236, 2024a.
Daya Guo, Dejian Yang, Haowei Zhang, Junxiao Song, Ruoyu Zhang, Runxin Xu, Qihao Zhu, Shirong Ma, Peiyi Wang,
Xiao Bi, et al. Deepseek-R1: Incentivizing reasoning capability in llms via reinforcement learning.arXiv preprint
arXiv:2501.12948, 2025.
Qingyan Guo, Rui Wang, Junliang Guo, Bei Li, Kaitao Song, Xu Tan, Guoqing Liu, Jiang Bian, and Yujiu Yang.
EvoPrompt: Connecting llms with evolutionary algorithms yields powerful prompt optimizers. In The Twelfth
International Conference on Learning Representations, 2024b.
Taicheng Guo, Xiuying Chen, Yaqi Wang, Ruidi Chang, Shichao Pei, Nitesh V. Chawla, Olaf Wiest, and Xiangliang
Zhang. Large language model based multi-agents: A survey of progress and challenges. In Proceedings of the
Thirty-Third International Joint Conference on Artificial Intelligence, pages 8048–8057, 2024c.
Zhicheng Guo, Sijie Cheng, Hao Wang, Shihao Liang, Yujia Qin, Peng Li, Zhiyuan Liu, Maosong Sun, and Yang Liu.
StableToolBench: Towards stable large-scale benchmarking on tool learning of large language models. InFindings of
the Association for Computational Linguistics, pages 11143–11156, 2024d.
Bernal Jimenez Gutierrez, Yiheng Shu, Yu Gu, Michihiro Yasunaga, and Yu Su.HippoRAG: Neurobiologically inspired
long-term memory for large language models. InAdvances in Neural Information Processing Systems, 2024.
Shanshan Han, Qifan Zhang, Yuhang Yao, Weizhao Jin, and Zhaozhuo Xu.LLM multi-agent systems: Challenges and
open problems. arXiv preprint arXiv:2402.03578, 2024.
Junda He, Christoph Treude, and David Lo.LLM-based multi-agent systems for software engineering: Literature review,
vision, and the road ahead.ACM Transactions on Software Engineering and Methodology, 34(5):1–30, 2025.
Zhitao He, Pengfei Cao, Chenhao Wang, Zhuoran Jin, Yubo Chen, Jiexin Xu, Huaijun Li, Xiaojian Jiang, Kang Liu, and
Jun Zhao. AgentsCourt: Building judicial decision-making agents with court debate simulation and legal knowledge
augmentation. arXiv preprint arXiv:2403.02959, 2024.
Sirui Hong, Mingchen Zhuge, Jonathan Chen, Xiawu Zheng, Yuheng Cheng, Jinlin Wang, Ceyao Zhang, Zili Wang,
Steven Ka Shing Yau, Zijuan Lin, Liyang Zhou, Chenyu Ran, Lingfeng Xiao, Chenglin Wu, and Jürgen Schmidhuber.
MetaGPT: Meta programming for A multi-agent collaborative framework. InThe Twelfth International Conference
on Learning Representations, 2024.
Yuki Hou, Haruki Tamoto, and Homei Miyashita. “my agent understands me better”: Integrating dynamic human-like
memory recall and consolidation in llm-based agents. InExtended Abstracts of the CHI Conference on Human Factors
in Computing Systems, CHI ’24, page 1–7. ACM, May 2024.
Zhipeng Hou, Junyi Tang, and Yipeng Wang. Halo: Hierarchical autonomous logic-oriented orchestration for multi-agent
llm systems. arXiv preprint arXiv:2505.13516, 2025.
Cho-Jui Hsieh, Si Si, Felix X. Yu, and Inderjit S. Dhillon. Automatic engineering of long prompts. InFindings of the
Association for Computational Linguistics, pages 10672–10685, 2024.
38

Chenxu Hu, Jie Fu, Chenzhuang Du, Simian Luo, Junbo Zhao, and Hang Zhao.ChatDB: Augmenting llms with
databases as their symbolic memory.arXiv preprint arXiv:2306.03901, 2023.
Edward J. Hu, Yelong Shen, Phillip Wallis, Zeyuan Allen-Zhu, Yuanzhi Li, Shean Wang, Lu Wang, and Weizhu
Chen. LoRA: Low-rank adaptation of large language models. InThe Tenth International Conference on Learning
Representations, 2022.
Shengran Hu, Cong Lu, and Jeff Clune. Automated design of agentic systems. InThe Thirteenth International Conference
on Learning Representations, 2025a.
Wenyang Hu, Yao Shu, Zongmin Yu, Zhaoxuan Wu, Xiaoqiang Lin, Zhongxiang Dai, See-Kiong Ng, and Bryan
Kian Hsiang Low. Localized zeroth-order prompt optimization.Advances in Neural Information Processing Systems,
37:86309–86345, 2024.
Xueyu Hu, Tao Xiong, Biao Yi, Zishu Wei, Ruixuan Xiao, Yurun Chen, Jiasheng Ye, Meiling Tao, Xiangxin Zhou, Ziyu
Zhao, et al.OS agents: A survey on mllm-based agents for computer, phone and browser use. InProceedings of the
63rd Annual Meeting of the Association for Computational Linguistics (Volume 1: Long Papers), pages 7436–7465,
2025b.
Zhaolin Hu, Yixiao Zhou, Zhongan Wang, Xin Li, Weimin Yang, Hehe Fan, and Yi Yang. Osda agent: Leveraging large
language models for de novo design of organic structure directing agents. InThe Thirteenth International Conference
on Learning Representations, 2025c.
Zhiting Hu and Tianmin Shu. Language models, agent models, and world models: The law for machine reasoning and
planning. arXiv preprint arXiv:2312.05230, 2023.
Chengsong Huang, Wenhao Yu, Xiaoyang Wang, Hongming Zhang, Zongxia Li, Ruosen Li, Jiaxin Huang, Haitao Mi,
and Dong Yu. R-Zero: Self-evolving reasoning llm from zero data.arXiv preprint arXiv:2508.05004, 2025.
Dong Huang, Jie M Zhang, Michael Luck, Qingwen Bu, Yuhao Qing, and Heming Cui.AgentCoder: Multi-agent-based
code generation with iterative testing and optimisation.arXiv preprint arXiv:2312.13010, 2023a.
Jen-tse Huang, Jiaxu Zhou, Tailin Jin, Xuhui Zhou, Zixi Chen, Wenxuan Wang, Youliang Yuan, Michael R Lyu,
and Maarten Sap. On the resilience of llm-based multi-agent collaboration with faulty agents. arXiv preprint
arXiv:2408.00989, 2024a.
Xu Huang, Weiwen Liu, Xiaolong Chen, Xingmei Wang, Hao Wang, Defu Lian, Yasheng Wang, Ruiming Tang, and
Enhong Chen. Understanding the planning of llm agents: A survey.arXiv preprint arXiv:2402.02716, 2024b.
Yue Huang, Jiawen Shi, Yuan Li, Chenrui Fan, Siyuan Wu, Qihui Zhang, Yixin Liu, Pan Zhou, Yao Wan, Neil Zhenqiang
Gong, et al. Metatool benchmark for large language models: Deciding whether to use tools and which to use.arXiv
preprint arXiv:2310.03128, 2023b.
Zhen Huang, Haoyang Zou, Xuefeng Li, Yixiu Liu, Yuxiang Zheng, Ethan Chern, Shijie Xia, Yiwei Qin, Weizhe Yuan,
and Pengfei Liu. O1 replication journey–part 2: Surpassing o1-preview through simple distillation, big progress or
bitter lesson? arXiv preprint arXiv:2411.16489, 2024c.
Binyuan Hui, Jian Yang, Zeyu Cui, Jiaxi Yang, Dayiheng Liu, Lei Zhang, Tianyu Liu, Jiajun Zhang, Bowen Yu, Keming
Lu, et al. Qwen2. 5-coder technical report.arXiv preprint arXiv:2409.12186, 2024.
Yoshitaka Inoue, Tianci Song, Xinling Wang, Augustin Luna, and Tianfan Fu. Drugagent: Multi-agent large language
model-based reasoning for drug-target interaction prediction. InICLR 2025 Workshop on Machine Learning for
Genomics Explorations, 2025.
Md. Ashraful Islam, Mohammed Eunus Ali, and Md. Rizwan Parvez.MapCoder: Multi-agent code generation for
competitive problem solving. In Proceedings of the 62nd Annual Meeting of the Association for Computational
Linguistics, pages 4912–4944, 2024.
Md. Ashraful Islam, Mohammed Eunus Ali, and Md. Rizwan Parvez.CodeSim: Multi-agent code generation and
problem solving through simulation-driven planning and debugging. InFindings of the Association for Computational
Linguistics: NAACL, 2025.
Aaron Jaech, Adam Kalai, Adam Lerer, Adam Richardson, Ahmed El-Kishky, Aiden Low, Alec Helyar, Aleksander
Madry, Alex Beutel, Alex Carney, et al. Openai o1 system card.CoRR, 2024.
Cong Jiang and Xiaolei Yang. Agentsbench: A multi-agent llm simulation framework for legal judgment prediction.
Systems, 13(8):641, 2025.
39

Juyong Jiang, Fan Wang, Jiasi Shen, Sungju Kim, and Sunghun Kim. A survey on large language models for code
generation. arXiv preprint arXiv:2406.00515, 2024.
Fangkai Jiao, Chengwei Qin, Zhengyuan Liu, Nancy F. Chen, and Shafiq Joty. Learning planning-based reasoning by
trajectories collection and process reward synthesizing. InProceedings of the 2024 Conference on Empirical Methods
in Natural Language Processing, pages 334–350, 2024.
Carlos E. Jimenez, John Yang, Alexander Wettig, Shunyu Yao, Kexin Pei, Ofir Press, and Karthik R. Narasimhan.
SWE-bench: Can language models resolve real-world github issues? InThe Twelfth International Conference on
Learning Representations, 2024.
Haolin Jin, Zechao Sun, and Huaming Chen.RGD: Multi-LLM based agent debugger via refinement and generation
guidance. In 2024 IEEE International Conference on Agents (ICA), pages 136–141. IEEE, 2024.
Mingyu Jin, Weidi Luo, Sitao Cheng, Xinyi Wang, Wenyue Hua, Ruixiang Tang, William Yang Wang, and Yongfeng
Zhang. Disentangling memory and reasoning ability in large language models. InProceedings of the 63rd Annual
Meeting of the Association for Computational Linguistics (Volume 1: Long Papers), pages 1681–1701, 2025.
Zixuan Ke, Austin Xu, Yifei Ming, Xuan-Phi Nguyen, Caiming Xiong, and Shafiq Joty.MAS-ZERO: Designing
multi-agent systems with zero supervision.arXiv preprint arXiv:2505.14996, 2025.
Akbir Khan, John Hughes, Dan Valentine, Laura Ruis, Kshitij Sachan, Ansh Radhakrishnan, Edward Grefenstette,
Samuel R. Bowman, Tim Rocktäschel, and Ethan Perez. Debating with more persuasive llms leads to more truthful
answers. InForty-first International Conference on Machine Learning, 2024.
Yubin Kim, Chanwoo Park, Hyewon Jeong, Yik S Chan, Xuhai Xu, Daniel McDuff, Hyeonhoon Lee, Marzyeh Ghassemi,
Cynthia Breazeal, and Hae W Park.MDAgents: An adaptive collaboration of llms for medical decision-making.
Advances in Neural Information Processing Systems, 37:79410–79452, 2024.
Ronny Ko, Jiseong Jeong, Shuyuan Zheng, Chuan Xiao, Tae-Wan Kim, Makoto Onizuka, and Won-Yong Shin. Seven
security challenges that must be solved in cross-domain multi-agent llm systems.arXiv preprint arXiv:2505.23847,
2025.
Jing Yu Koh, Robert Lo, Lawrence Jang, Vikram Duvvur, Ming Chong Lim, Po-Yu Huang, Graham Neubig, Shuyan
Zhou, Russ Salakhutdinov, and Daniel Fried.VisualWebArena: Evaluating multimodal agents on realistic visual web
tasks. In Proceedings of the 62nd Annual Meeting of the Association for Computational Linguistics (Volume 1: Long
Papers), pages 881–905, 2024.
Dezhang Kong, Shi Lin, Zhenhua Xu, Zhebo Wang, Minghao Li, Yufeng Li, Yilun Zhang, Hujin Peng, Zeyang Sha,
Yuyuan Li, Changting Lin, Xun Wang, Xuan Liu, Ningyu Zhang, Chaochao Chen, Muhammad Khurram Khan, and
Meng Han. A survey of llm-driven ai agent communication: Protocols, security risks, and defense countermeasures,
2025.
Igor Kononenko. Machine learning for medical diagnosis: history, state of the art and perspective.Artificial Intelligence
in Medicine, 23(1):89–109, 2001. ISSN 0933-3657. doi: https://doi.org/10.1016/S0933-3657(01)00077-X.
Naveen Krishnan. Advancing multi-agent systems through model context protocol: Architecture, implementation, and
applications. arXiv preprint arXiv:2504.21030, 2025.
Bespoke Labs. Bespoke-stratos: The unreasonable effectiveness of reasoning distillation.
www.bespokelabs.ai/blog/bespoke-stratos-the-unreasonable-effectiveness-of-reasoning-distillation, 2025. Accessed:
2025-01-22.
Hanyu Lai, Xiao Liu, Iat Long Iong, Shuntian Yao, Yuxuan Chen, Pengbo Shen, Hao Yu, Hanchen Zhang, Xiaohan Zhang,
Yuxiao Dong, and Jie Tang.AutoWebGLM: A large language model-based web navigating agent. InProceedings of
the 30th ACM SIGKDD Conference on Knowledge Discovery and Data Mining, pages 5295–5306. ACM, 2024a.
Xin Lai, Zhuotao Tian, Yukang Chen, Senqiao Yang, Xiangru Peng, and Jiaya Jia.Step-DPO: Step-wise preference
optimization for long-chain reasoning of llms.arXiv preprint arXiv:2406.18629, 2024b.
Nathan Lambert, Jacob Morrison, Valentina Pyatkin, Shengyi Huang, Hamish Ivison, Faeze Brahman, Lester James V
Miranda, Alisa Liu, Nouha Dziri, Shane Lyu, et al. Tulu 3: Pushing frontiers in open language model post-training.
arXiv preprint arXiv:2411.15124, 2024.
Greg Landrum. Rdkit documentation.Release, 1(1-79):4, 2013.
Cheryl Lee, Chunqiu Steven Xia, Longji Yang, Jen-tse Huang, Zhouruixin Zhu, Lingming Zhang, and Michael R Lyu. A
unified debugging approach via llm-based multi-agent synergy.arXiv preprint arXiv:2404.17153, 2024a.
40

Dongkyu Lee, Chandana Satya Prakash, Jack FitzGerald, and Jens Lehmann.MATTER:memory-augmented transformer
using heterogeneous knowledge sources. InFindings of the Association for Computational Linguistics, pages 16110–
16121, 2024b.
Juyong Lee, Dongyoon Hahm, June Suk Choi, W Bradley Knox, and Kimin Lee.MobileSafetyBench: Evaluating safety
of autonomous agents in mobile device control.arXiv preprint arXiv:2410.17520, 2024c.
Kuang-Huei Lee, Xinyun Chen, Hiroki Furuta, John F. Canny, and Ian Fischer. A human-inspired reading agent with
gist memory of very long contexts. InForty-first International Conference on Machine Learning, 2024d.
Hui Yi Leong and Yuqing Wu.DynaSwarm: Dynamically graph structure selection for llm-based multi-agent system.
arXiv preprint arXiv:2507.23261, 2025.
Binxu Li, Tiankai Yan, Yuanting Pan, Jie Luo, Ruiyang Ji, Jiayuan Ding, Zhe Xu, Shilong Liu, Haoyu Dong, Zihao Lin,
et al. MMedAgent: Learning to use medical tools with multi-modal agent.arXiv preprint arXiv:2407.02483, 2024a.
Boyi Li, Zhonghan Zhao, Der-Horng Lee, and Gaoang Wang. Adaptive graph pruning for multi-agent communication.
arXiv preprint arXiv:2506.02951, 2025a.
Chengpeng Li, Zhengyang Tang, Ziniu Li, Mingfeng Xue, Keqin Bao, Tian Ding, Ruoyu Sun, Benyou Wang, Xiang
Wang, Junyang Lin, et al.CoRT: Code-integrated reasoning within thinking.arXiv preprint arXiv:2506.09820, 2025b.
Chengpeng Li, Mingfeng Xue, Zhenru Zhang, Jiaxi Yang, Beichen Zhang, Xiang Wang, Bowen Yu, Binyuan Hui, Junyang
Lin, and Dayiheng Liu. START: Self-taught reasoner with tools.arXiv preprint arXiv:2503.04625, 2025c.
Guohao Li, Hasan Abed Al Kader Hammoud, Hani Itani, Dmitrii Khizbullin, and Bernard Ghanem. CAMEL:
Communicative agents for ”mind” exploration of large language model society. InThirty-seventh Conference on Neural
Information Processing Systems, 2023a.
Haitao Li, Qian Dong, Junjie Chen, Huixue Su, Yujia Zhou, Qingyao Ai, Ziyi Ye, and Yiqun Liu.LLMs-as-Judges: a
comprehensive survey on llm-based evaluation methods.arXiv preprint arXiv:2412.05579, 2024b.
Junkai Li, Yunghwei Lai, Weitao Li, Jingyi Ren, Meng Zhang, Xinhui Kang, Siyu Wang, Peng Li, Ya-Qin Zhang, Weizhi
Ma, et al. Agent hospital: A simulacrum of hospital with evolvable medical agents.arXiv preprint arXiv:2405.02957,
2024c.
Minghao Li, Yingxiu Zhao, Bowen Yu, Feifan Song, Hangyu Li, Haiyang Yu, Zhoujun Li, Fei Huang, and Yongbin Li.
API-Bank: A comprehensive benchmark for tool-augmented llms. InProceedings of the 2023 Conference on Empirical
Methods in Natural Language Processing, pages 3102–3116, 2023b.
Pengxiang Li, Zhi Gao, Bofei Zhang, Yapeng Mi, Xiaojian Ma, Chenrui Shi, Tao Yuan, Yuwei Wu, Yunde Jia, Song-Chun
Zhu, et al. Iterative tool usage exploration for multimodal agents via step-wise preference tuning.arXiv preprint
arXiv:2504.21561, 2025d.
Shilong Li, Yancheng He, Hangyu Guo, Xingyuan Bu, Ge Bai, Jie Liu, Jiaheng Liu, Xingwei Qu, Yangguang Li, Wanli
Ouyang, Wenbo Su, and Bo Zheng.GraphReader: Building graph-based agent to enhance long-context abilities of
large language models. InFindings of the Association for Computational Linguistics: EMNLP, pages 12758–12786,
2024d.
Shilong Li, Xingyuan Bu, Wenjie Wang, Jiaheng Liu, Jun Dong, Haoyang He, Hao Lu, Haozhe Zhang, Chenchen Jing,
Zhen Li, et al. MM-BrowseComp: A comprehensive benchmark for multimodal browsing agents.arXiv preprint
arXiv:2508.13186, 2025e.
Xiangyu Li, Yawen Zeng, Xiaofen Xing, Jin Xu, and Xiangmin Xu.HedgeAgents: A balanced-aware multi-agent financial
trading system. InCompanion Proceedings of the ACM on Web Conference 2025, pages 296–305, 2025f.
Xiaonan Li and Xipeng Qiu.MoT: Memory-of-thought enables chatgpt to self-improve. InProceedings of the 2023
Conference on Empirical Methods in Natural Language Processing, pages 6354–6374, 2023.
Xiaoxi Li, Jiajie Jin, Guanting Dong, Hongjin Qian, Yutao Zhu, Yongkang Wu, Ji-Rong Wen, and Zhicheng Dou.
WebThinker: Empowering large reasoning models with deep research capability.arXiv preprint arXiv:2504.21776,
2025g.
Xin Sky Li, Qizhi Chu, Yubin Chen, Yang Liu, Yaoqi Liu, Zekai Yu, Weize Chen, Chen Qian, Chuan Shi, and Cheng
Yang. GraphTeam: Facilitating large language model-based graph analysis via multi-agent collaboration.arXiv
preprint arXiv:2410.18032, 2024e.
Xinyi Li, Sai Wang, Siqi Zeng, Yu Wu, and Yi Yang. A survey on llm-based multi-agent systems: workflow, infrastructure,
and challenges. Vicinagearth, 1(1):9, 2024f.
41

Yang Li, Yangyang Yu, Haohang Li, Zhi Chen, and Khaldoun Khashanah.TradingGPT: Multi-agent system with
layered memory and distinct characters for enhanced financial trading performance.arXiv preprint arXiv:2309.03736,
2023c.
Yaoru Li, Shunyu Liu, Tongya Zheng, and Mingli Song. Parallelized planning-acting for efficientLLM-based multi-agent
systems. arXiv preprint arXiv:2503.03505, 2025h.
Yunxuan Li, Yibing Du, Jiageng Zhang, Le Hou, Peter Grabowski, Yeqing Li, and Eugene Ie. Improving multi-agent
debate with sparse communication topology. InFindings of the Association for Computational Linguistics: EMNLP,
pages 7281–7294. Association for Computational Linguistics, 2024g.
Zelong Li, Shuyuan Xu, Kai Mei, Wenyue Hua, Balaji Rama, Om Raheja, Hao Wang, He Zhu, and Yongfeng Zhang.
AutoFlow: Automated workflow generation for large language model agents.arXiv preprint arXiv:2407.12821, 2024h.
Zhuoqun Li, Xuanang Chen, Haiyang Yu, Hongyu Lin, Yaojie Lu, Qiaoyu Tang, Fei Huang, Xianpei Han, Le Sun,
and Yongbin Li.StructRAG: Boosting knowledge intensive reasoning of llms via inference-time hybrid information
structurization. In The Thirteenth International Conference on Learning Representations, 2025i.
Zihao Li, Weiwei Yi, and Jiahong Chen. Accuracy paradox in large language models: Regulating hallucination risks in
generative ai. arXiv preprint, 2025j.
Tian Liang, Zhiwei He, Wenxiang Jiao, Xing Wang, Yan Wang, Rui Wang, Yujiu Yang, Shuming Shi, and Zhaopeng
Tu. Encouraging divergent thinking in large language models through multi-agen debate. InProceedings of the 2024
Conference on Empirical Methods in Natural Language Processing, pages 17889–17904, 2024.
Junwei Liao, Muning Wen, Jun Wang, and Weinan Zhang.MARFT: Multi-agent reinforcement fine-tuning.arXiv
preprint arXiv:2504.16129, 2025.
Xiaoqiang Lin, Zhongxiang Dai, Arun Verma, See-Kiong Ng, Patrick Jaillet, and Bryan Kian Hsiang Low. Prompt
optimization with human feedback.arXiv preprint arXiv:2405.17346, 2024a.
Xiaoqiang Lin, Zhaoxuan Wu, Zhongxiang Dai, Wenyang Hu, Yao Shu, See-Kiong Ng, Patrick Jaillet, and Bryan
Kian Hsiang Low. Use your INSTINCT: instruction optimization for llms using neural bandits coupled with
transformers. In Forty-first International Conference on Machine Learning, 2024b.
Yi-Cheng Lin, Kang-Chieh Chen, Zhe-Yan Li, Tzu-Heng Wu, Tzu-Hsuan Wu, Kuan-Yu Chen, Hung-yi Lee, and
Yun-Nung Chen. Creativity in llm-based multi-agent systems: A survey.arXiv preprint arXiv:2505.21116, 2025.
Bang Liu, Xinfeng Li, Jiayi Zhang, Jinlin Wang, Tanjin He, Sirui Hong, Hongzhang Liu, Shaokun Zhang, Kaitao Song,
Kunlun Zhu, et al. Advances and challenges in foundation agents: From brain-inspired intelligence to evolutionary,
collaborative, and safe systems.arXiv preprint arXiv:2504.01990, 2025a.
Bo Liu, Leon Guertler, Simon Yu, Zichen Liu, Penghui Qi, Daniel Balcells, Mickel Liu, Cheston Tan, Weiyan Shi, Min
Lin, et al.SPIRAL: Self-play on zero-sum games incentivizes reasoning via multi-agent multi-turn reinforcement
learning. arXiv preprint arXiv:2506.24119, 2025b.
Chris Yuhao Liu, Liang Zeng, Jiacai Liu, Rui Yan, Jujie He, Chaojie Wang, Shuicheng Yan, Yang Liu, and Yahui Zhou.
Skywork-reward: Bag of tricks for reward modeling in llms.arXiv preprint arXiv:2410.18451, 2024a.
Chris Yuhao Liu, Liang Zeng, Yuzhen Xiao, Jujie He, Jiacai Liu, Chaojie Wang, Rui Yan, Wei Shen, Fuxiang Zhang,
Jiacheng Xu, et al. Skywork-reward-v2: Scaling preference data curation via human-ai synergy.arXiv preprint
arXiv:2507.01352, 2025c.
Nelson F. Liu, Kevin Lin, John Hewitt, Ashwin Paranjape, Michele Bevilacqua, Fabio Petroni, and Percy Liang. Lost in
the middle: How language models use long contexts.Transactions of the Association for Computational Linguistics,
12:157–173, 2024b.
Siwei Liu, Jinyuan Fang, Han Zhou, Yingxu Wang, and Zaiqiao Meng.SEW: Self-evolving agentic workflows for
automated code generation.arXiv preprint arXiv:2505.18646, 2025d.
Wei Liu, Junlong Li, Xiwen Zhang, Fan Zhou, Yu Cheng, and Junxian He. Diving into self-evolving training for
multimodal reasoning. InForty-second International Conference on Machine Learning, 2025e.
Wei Liu, Ruochen Zhou, Yiyun Deng, Yuzhen Huang, Junteng Liu, Yuntian Deng, Yizhe Zhang, and Junxian He. Learn
to reason efficiently with adaptive length-based reward shaping.arXiv preprint arXiv:2505.15612, 2025f.
Weiwen Liu, Xu Huang, Xingshan Zeng, Xinlong Hao, Shuai Yu, Dexun Li, Shuai Wang, Weinan Gan, Zhengying Liu,
Yuanqing Yu, Zezhong Wang, Yuxian Wang, Wu Ning, Yutai Hou, Bin Wang, Chuhan Wu, Xinzhi Wang, Yong
Liu, Yasheng Wang, Duyu Tang, Dandan Tu, Lifeng Shang, Xin Jiang, Ruiming Tang, Defu Lian, Qun Liu, and
42

Enhong Chen. ToolACE: Winning the points of LLM function calling. InThe Thirteenth International Conference
on Learning Representations, 2025g.
Xiao Liu, Hao Yu, Hanchen Zhang, Yifan Xu, Xuanyu Lei, Hanyu Lai, Yu Gu, Hangliang Ding, Kaiwen Men, Kejuan
Yang, et al. AgentBench: Evaluating llms as agents.arXiv preprint arXiv:2308.03688, 2023a.
Yanming Liu, Xinyue Peng, Jiannan Cao, Shi Bo, Yuwei Zhang, Xuhong Zhang, Sheng Cheng, Xun Wang, Jianwei Yin,
and Tianyu Du.Tool-Planner: Task planning with clusters across multiple tools. InThe Thirteenth International
Conference on Learning Representations, 2025h.
Yixin Liu, Guibin Zhang, Kun Wang, Shiyuan Li, and Shirui Pan. Graph-augmented large language model agents:
Current progress and future prospects.arXiv preprint arXiv:2507.21407, 2025i.
Zijun Liu, Yanzhe Zhang, Peng Li, Yang Liu, and Diyi Yang. DynamicLLM-Agentnetwork: AnLLM-agent collaboration
framework with agent team optimization.arXiv preprint arXiv:2310.02170, 2023b.
Google LLC and A2A Project Contributors. Agent2Agent (A2A) Protocol. https://github.com/a2aproject/A2A.
Apache License 2.0, accessed 2025-07-31.
Lin Long, Yichen He, Wentao Ye, Yiyuan Pan, Yuan Lin, Hang Li, Junbo Zhao, and Wei Li. Seeing, listening,
remembering, and reasoning: A multimodal agent with long-term memory.arXiv preprint arXiv:2508.09736, 2025.
Manikanta Loya, Divya Sinha, and Richard Futrell. Exploring the sensitivity of llms’ decision-making capabilities:
Insights from prompt variations and hyperparameters. InFindings of the Association for Computational Linguistics:
EMNLP, pages 3711–3716, 2023.
Chris Lu, Cong Lu, Robert Tjarko Lange, Jakob Foerster, Jeff Clune, and David Ha. TheAI scientist: Towards fully
automated open-ended scientific discovery.arXiv preprint arXiv:2408.06292, 2024a.
Junru Lu, Siyu An, Mingbao Lin, Gabriele Pergola, Yulan He, Di Yin, Xing Sun, and Yunsheng Wu.MemoChat: Tuning
LLMs to use memos for consistent long-range open-domain conversation.arXiv preprint arXiv:2308.08239, 2023.
Siyuan Lu, Jiaqi Shao, Bing Luo, and Tao Lin.MorphAgent: Empowering agents through self-evolving profiles and
decentralized collaboration. arXiv preprint arXiv:2410.15048, 2024b.
Yao Lu, Jiayi Wang, Raphael Tang, Sebastian Riedel, and Pontus Stenetorp. Strings from the library of babel: Random
sampling as a strong baseline for prompt optimisation. InProceedings of the 2024 Conference of the North American
Chapter of the Association for Computational Linguistics: Human Language Technologies, pages 2221–2231, 2024c.
Junyu Luo, Weizhi Zhang, Ye Yuan, Yusheng Zhao, Junwei Yang, Yiyang Gu, Bohan Wu, Binqi Chen, Ziyue Qiao,
Qingqing Long, et al. Large language model agent: A survey on methodology, applications and challenges.arXiv
preprint arXiv:2503.21460, 2025a.
Yichen Luo, Yebo Feng, Jiahua Xu, Paolo Tasca, and Yang Liu.LLM-powered multi-agent system for automated crypto
portfolio management. arXiv preprint arXiv:2501.00826, 2025b.
Andres M. Bran, Sam Cox, Oliver Schilter, Carlo Baldassari, Andrew D White, and Philippe Schwaller. Augmenting
large language models with chemistry tools.Nature Machine Intelligence, 6(5):525–535, 2024.
Xiaowen Ma, Chenyang Lin, Yao Zhang, Volker Tresp, and Yunpu Ma. Agentic neural networks: Self-evolving multi-agent
systems via textual backpropagation.arXiv preprint arXiv:2506.09046, 2025.
Yubo Ma, Zhibin Gou, Junheng Hao, Ruochen Xu, Shuohang Wang, Liangming Pan, Yujiu Yang, Yixin Cao, and Aixin
Sun. SciAgent: Tool-augmented language models for scientific reasoning. InProceedings of the 2024 Conference on
Empirical Methods in Natural Language Processing 2024, pages 15701–15736, 2024.
Aman Madaan, Niket Tandon, Prakhar Gupta, Skyler Hallinan, Luyu Gao, Sarah Wiegreffe, Uri Alon, Nouha Dziri,
Shrimai Prabhumoye, Yiming Yang, et al.Self-Refine: Iterative refinement with self-feedback.Advances in Neural
Information Processing Systems, pages 46534–46594, 2023.
Nour Makke and Sanjay Chawla. Interpretable scientific discovery with symbolic regression: a review. Artificial
Intelligence Review, 57(1):2, 2024.
Raphael Mannadiar and Hans Vangheluwe. Debugging in domain-specific modelling. InInternational Conference on
Software Language Engineering, pages 276–285. Springer, 2010.
Samuele Marro and Agora Protocol Contributors. Agora Protocol (AGORA).https://agoraprotocol.org/. MIT License,
accessed 2025-07-31.
43

Andrew D McNaughton, Gautham Krishna Sankar Ramalaxmi, Agustin Kruel, Carter R Knutson, Rohith A Varikoti,
and Neeraj Kumar. Cactus: Chemistry agent connecting tool usage to science.ACS omega, 9(46):46563–46573, 2024.
Grégoire Mialon, Clémentine Fourrier, Thomas Wolf, Yann LeCun, and Thomas Scialom.GAIA: a benchmark for
general ai assistants. InThe Twelfth International Conference on Learning Representations, 2023.
Yingqian Min, Zhipeng Chen, Jinhao Jiang, Jie Chen, Jia Deng, Yiwen Hu, Yiru Tang, Jiapeng Wang, Xiaoxue Cheng,
Huatong Song, et al. Imitate, explore, and self-improve: A reproduction report on slow-thinking reasoning systems.
arXiv preprint arXiv:2412.09413, 2024.
Eric Mitchell, Charles Lin, Antoine Bosselut, Chelsea Finn, and Christopher D. Manning. Fast model editing at scale.
In The Tenth International Conference on Learning Representations, 2022.
Ali Modarressi, Ayyoob Imani, Mohsen Fayyaz, and Hinrich Schütze.RET-LLM: Towards a general read-write memory
for large language models.arXiv preprint arXiv:2305.14322, 2023.
Sumeet Ramesh Motwani, Chandler Smith, Rocktim Jyoti Das, Rafael Rafailov, Ivan Laptev, Philip HS Torr, Fabio
Pizzati, Ronald Clark, and Christian Schroeder de Witt.MALT: Improving reasoning with multi-agent llm training.
arXiv preprint arXiv:2412.01928, 2024.
Jaap MJ Murre and Joeri Dros. Replication and analysis of ebbinghaus’ forgetting curve.PloS one, 10(7):e0120644,
2015.
Magnus Müller and Gregor Žunič. Browser use: Enable AI to control your browser, 2024. https://github.com/
browser-use/browser-use.
Deepak Nathani, Lovish Madaan, Nicholas Roberts, Nikolay Bashlykov, Ajay Menon, Vincent Moens, Amar Budhiraja,
Despoina Magka, Vladislav Vorotilov, Gaurav Chaurasia, et al.MLGym: A new framework and benchmark for
advancing ai research agents.arXiv preprint arXiv:2502.14499, 2025.
Ansong Ni, Srini Iyer, Dragomir Radev, Veselin Stoyanov, Wen-tau Yih, Sida Wang, and Xi Victoria Lin.LEVER:
Learning to verify language-to-code generation with execution. InInternational Conference on Machine Learning,
pages 26106–26128. PMLR, 2023.
Ansong Ni, Miltiadis Allamanis, Arman Cohan, Yinlin Deng, Kensen Shi, Charles Sutton, and Pengcheng Yin. NExT:
Teaching large language models to reason about code execution. InForty-first International Conference on Machine
Learning, 2024.
Boye Niu, Yiliao Song, Kai Lian, Yifan Shen, Yu Yao, Kun Zhang, and Tongliang Liu. Flow: Modularized agentic
workflow automation. InThe Thirteenth International Conference on Learning Representations, 2025.
Alexander Novikov, Ngân V˜ u, Marvin Eisenberger, Emilien Dupont, Po-Sen Huang, Adam Zsolt Wagner, Sergey
Shirobokov, Borislav Kozlovskii, Francisco JR Ruiz, Abbas Mehrabian, et al.AlphaEvolve: A coding agent for
scientific and algorithmic discovery.arXiv preprint arXiv:2506.13131, 2025.
Krista Opsahl-Ong, Michael J. Ryan, Josh Purtell, David Broman, Christopher Potts, Matei Zaharia, and Omar Khattab.
Optimizing instructions and demonstrations for multi-stage language model programs. InProceedings of the 2024
Conference on Empirical Methods in Natural Language Processing, pages 9340–9366, 2024.
Long Ouyang, Jeffrey Wu, Xu Jiang, Diogo Almeida, Carroll Wainwright, Pamela Mishkin, Chong Zhang, Sandhini
Agarwal, Katarina Slama, Alex Ray, et al. Training language models to follow instructions with human feedback.
Advances in neural information processing systems, 35:27730–27744, 2022.
Charles Packer, Vivian Fang, Shishir G Patil, Kevin Lin, Sarah Wooders, and Joseph E Gonzalez.MemGPT: Towards
llms as operating systems.arXiv preprint arXiv:2310.08560, 2023.
Alexander Pan, Jun Shern Chan, Andy Zou, Nathaniel Li, Steven Basart, Thomas Woodside, Hanlin Zhang, Scott
Emmons, and Dan Hendrycks. Do the rewards justify the means? measuring trade-offs between rewards and ethical
behavior in the machiavelli benchmark. InInternational conference on machine learning, pages 26837–26867. PMLR,
2023.
Melissa Z Pan, Mert Cemri, Lakshya A Agrawal, Shuyi Yang, Bhavya Chopra, Rishabh Tiwari, Kurt Keutzer, Aditya
Parameswaran, Kannan Ramchandran, Dan Klein, Joseph E. Gonzalez, Matei Zaharia, and Ion Stoica. Why do
Multi-Agent systems fail? InICLR 2025 Workshop on Building Trust in Language Models and Applications, 2025a.
Rui Pan, Shuo Xing, Shizhe Diao, Wenhe Sun, Xiang Liu, Kashun Shum, Jipeng Zhang, Renjie Pi, and Tong Zhang.
Plum: Prompt learning using metaheuristics. InFindings of the Association for Computational Linguistics, pages
2177–2197, 2024a.
44

Ruwei Pan, Hongyu Zhang, and Chao Liu.CodeCoR: An llm-based self-reflective multi-agent framework for code
generation. arXiv preprint arXiv:2501.07811, 2025b.
Yichen Pan, Dehan Kong, Sida Zhou, Cheng Cui, Yifei Leng, Bing Jiang, Hangyu Liu, Yanyi Shang, Shuyan Zhou,
Tongshuang Wu, et al.WebCanvas: Benchmarking web agents in online environments.arXiv preprint arXiv:2406.12373,
2024b.
Chanwoo Park, Seungju Han, Xingzhi Guo, Asuman E. Ozdaglar, Kaiqing Zhang, and Joo-Kyung Kim.MAPoRL:
Multi-agent post-co-training for collaborative large language models with reinforcement learning. InProceedings of the
63rd Annual Meeting of the Association for Computational Linguistics (Volume 1: Long Papers), pages 30215–30248,
2025.
Joon Sung Park, Joseph O’Brien, Carrie Jun Cai, Meredith Ringel Morris, Percy Liang, and Michael S Bernstein.
Generative agents: Interactive simulacra of human behavior. InProceedings of the 36th annual acm symposium on
user interface software and technology, pages 1–22, 2023.
Junyeong Park, Junmo Cho, and Sungjin Ahn.MrSteve: Instruction-following agents in minecraft with what-where-when
memory. arXiv preprint arXiv:2411.06736, 2024.
Shishir G Patil, Tianjun Zhang, Xin Wang, and Joseph E Gonzalez. Gorilla: Large language model connected with
massive APIs.Advances in Neural Information Processing Systems, 37:126544–126565, 2024.
Anthropic PBC and Model Context Protocol Contributors. Model Context Protocol (MCP). https://
modelcontextprotocol.io/overview. MIT License, accessed 2025-07-31.
Jonas Pfeiffer, Aishwarya Kamath, Andreas Rücklé, Kyunghyun Cho, and Iryna Gurevych.AdapterFusion: Non-
destructive task composition for transfer learning. InProceedings of the 16th Conference of the European Chapter of
the Association for Computational Linguistics, pages 487–503, 2021.
Akshara Prabhakar, Zuxin Liu, Ming Zhu, Jianguo Zhang, Tulika Awalgaonkar, Shiyu Wang, Zhiwei Liu, Haolin Chen,
Thai Hoang, Juan Carlos Niebles, et al.APIGen-MT: Agentic pipeline for multi-turn data generation via simulated
agent-human interplay.arXiv preprint arXiv:2504.03601, 2025.
Archiki Prasad, Peter Hase, Xiang Zhou, and Mohit Bansal.GRIPS: Gradient-free, edit-based instruction search for
prompting large language models. In Andreas Vlachos and Isabelle Augenstein, editors,Proceedings of the 17th
Conference of the European Chapter of the Association for Computational Linguistics, pages 3827–3846, 2023.
Reid Pryzant, Dan Iter, Jerry Li, Yin Tat Lee, Chenguang Zhu, and Michael Zeng. Automatic prompt optimization
with "gradient descent" and beam search. InProceedings of the 2023 Conference on Empirical Methods in Natural
Language Processing, pages 7957–7968, 2023.
Yingming Pu, Tao Lin, and Hongyu Chen.PiFlow: Principle-aware scientific discovery with multi-agent collaboration.
arXiv preprint arXiv:2505.15047, 2025.
Pranav Putta, Edmund Mills, Naman Garg, Sumeet Motwani, Chelsea Finn, Divyansh Garg, and Rafael Rafailov. Agent
Q: Advanced reasoning and learning for autonomous ai agents.arXiv preprint arXiv:2408.07199, 2024.
Meghana Puvvadi, Sai Kumar Arava, Adarsh Santoria, Sesha Sai Prasanna Chennupati, and Harsha Vardhan Puvvadi.
Coding agents: A comprehensive survey of automated bug fixing systems and benchmarks. In2025 IEEE 14th
International Conference on Communication Systems and Network Technologies (CSNT), pages 680–686. IEEE, 2025.
Chen Qian, Wei Liu, Hongzhang Liu, Nuo Chen, Yufan Dang, Jiahao Li, Cheng Yang, Weize Chen, Yusheng Su,
Xin Cong, Juyuan Xu, Dahai Li, Zhiyuan Liu, and Maosong Sun.ChatDev: Communicative agents for software
development. InProceedings of the 62nd Annual Meeting of the Association for Computational Linguistics (Volume 1:
Long Papers), pages 15174–15186, 2024.
Cheng Qian, Chi Han, Yi R Fung, Yujia Qin, Zhiyuan Liu, and Heng Ji.CREATOR: Tool creation for disentangling
abstract and concrete reasoning of large language models. In2023 Findings of the Association for Computational
Linguistics: EMNLP 2023, pages 6922–6939. Association for Computational Linguistics (ACL), 2023.
Cheng Qian, Emre Can Acikgoz, Qi He, Hongru Wang, Xiusi Chen, Dilek Hakkani-Tür, Gokhan Tur, and Heng Ji.
ToolRL: Reward is all tool learning needs.arXiv preprint arXiv:2504.13958, 2025a.
Yiyue Qian, Shinan Zhang, Yun Zhou, Haibo Ding, Diego Socolinsky, and Yi Zhang. EnhancingLLM-as-a-Judge via
multi-agent collaboration. amazon.science, 2025b.
45

Shuofei Qiao, Runnan Fang, Ningyu Zhang, Yuqi Zhu, Xiang Chen, Shumin Deng, Yong Jiang, Pengjun Xie, Fei Huang,
and Huajun Chen. Agent planning with world knowledge model. InAdvances in Neural Information Processing
Systems, 2024.
Yujia Qin, Shihao Liang, Yining Ye, Kunlun Zhu, Lan Yan, Yaxi Lu, Yankai Lin, Xin Cong, Xiangru Tang, Bill Qian,
Sihan Zhao, Lauren Hong, Runchu Tian, Ruobing Xie, Jie Zhou, Mark Gerstein, Dahai Li, Zhiyuan Liu, and Maosong
Sun. ToolLLM: Facilitating large language models to master 16000+ real-world apis. InThe Twelfth International
Conference on Learning Representations, 2024.
Jiahao Qiu, Xuan Qi, Tongcheng Zhang, Xinzhe Juan, Jiacheng Guo, Yifu Lu, Yimin Wang, Zixin Yao, Qihan Ren,
Xun Jiang, et al. Alita: Generalist agent enabling scalable agentic reasoning with minimal predefinition and maximal
self-evolution. arXiv preprint arXiv:2505.20286, 2025.
Changle Qu, Sunhao Dai, Xiaochi Wei, Hengyi Cai, Shuaiqiang Wang, Dawei Yin, Jun Xu, and Ji-Rong Wen. From
exploration to mastery: Enabling LLMs to master tools via self-driven interactions. InThe Thirteenth International
Conference on Learning Representations, 2025.
Rafael Rafailov, Archit Sharma, Eric Mitchell, Christopher D Manning, Stefano Ermon, and Chelsea Finn. Direct
preference optimization: Your language model is secretly a reward model. InThirty-seventh Conference on Neural
Information Processing Systems, 2023.
Asif Rahman, Veljko Cvetkovic, Kathleen Reece, Aidan Walters, Yasir Hassan, Aneesh Tummeti, Bryan Torres, Denise
Cooney, Margaret Ellis, and Dimitrios S Nikolopoulos.MARCO: Multi-agent code optimization with real-time
knowledge integration for high-performance computing.arXiv preprint arXiv:2505.03906, 2025.
Zeeshan Rasheed, Malik Abdul Sami, Kai-Kristian Kemell, Muhammad Waseem, Mika Saari, Kari Systä, and Pekka
Abrahamsson. CodePori: Large-scale system for autonomous software development using multi-agent technology.
arXiv preprint arXiv:2402.01411, 2024.
Christopher Rawles, Sarah Clinckemaillie, Yifan Chang, Jonathan Waltz, Gabrielle Lau, Marybeth Fair, Alice Li,
William Bishop, Wei Li, Folawiyo Campbell-Ajala, et al.AndroidWorld: A dynamic benchmarking environment for
autonomous agents. arXiv preprint arXiv:2405.14573, 2024.
Shaina Raza, Ranjan Sapkota, Manoj Karkee, and Christos Emmanouilidis.TRiSM for agentic ai: A review of trust,
risk, and security management in llm-based agentic multi-agent systems.arXiv preprint arXiv:2506.04133, 2025.
Aymeric Roucher, Albert Villanova del Moral, Thomas Wolf, Leandro von Werra, and Erik Kaunismäki. “smolagents”: a
smol library to build great agentic systems.https://github.com/huggingface/smolagents, 2025.
Kai Ruan, Xuan Wang, Jixiang Hong, Peng Wang, Yang Liu, and Hao Sun. Liveideabench: Evaluating llms’ divergent
thinking for scientific idea generation with minimal context.arXiv preprint arXiv:2412.17596, 2024.
Kai Ruan, Mowen Huang, Ji-Rong Wen, and Hao Sun. BenchmarkingLLMs’ swarm intelligence. arXiv preprint
arXiv:2505.04364, 2025.
Ali Safaya and Deniz Yuret. Neurocache: Efficient vector retrieval for long-range language modeling. InProceedings
of the 2024 Conference of the North American Chapter of the Association for Computational Linguistics: Human
Language Technologies (Volume 1: Long Papers), pages 870–883, 2024.
Saket Sarin, Sunil K Singh, Sudhakar Kumar, Shivam Goyal, Brij Bhooshan Gupta, Wadee Alhalabi, and Varsha Arya.
Unleashing the power of multi-agent reinforcement learning for algorithmic trading in the digital financial frontier and
enterprise information systems.Computers, Materials & Continua, 80(2), 2024.
Anjana Sarkar and Soumyendu Sarkar. Survey ofLLM agent communication with mcp: A software design pattern
centric review. arXiv preprint arXiv:2506.05364, 2025.
Timo Schick, Jane Dwivedi-Yu, Roberto Dessì, Roberta Raileanu, Maria Lomeli, Eric Hambro, Luke Zettlemoyer, Nicola
Cancedda, and Thomas Scialom. ToolFormer: Language models can teach themselves to use tools.Advances in
Neural Information Processing Systems, 36:68539–68551, 2023.
Samuel Schmidgall, Rojin Ziaei, Carl Harris, Eduardo Reis, Jeffrey Jopling, and Michael Moor.AgentClinic: a multimodal
agent benchmark to evaluate ai in simulated clinical environments.arXiv preprint arXiv:2405.07960, 2024.
Lennart Schneider, Martin Wistuba, Aaron Klein, Jacek Golebiowski, Giovanni Zappella, and Felice Antonio Merra.
Hyperband-based bayesian optimization for black-box prompt selection. InForty-second International Conference on
Machine Learning, 2025.
46

Amrith Setlur, Chirag Nagpal, Adam Fisch, Xinyang Geng, Jacob Eisenstein, Rishabh Agarwal, Alekh Agarwal, Jonathan
Berant, and Aviral Kumar. Rewarding progress: Scaling automated process verifiers for LLM reasoning. InThe
Thirteenth International Conference on Learning Representations, 2025.
Zhihong Shao, Peiyi Wang, Qihao Zhu, Runxin Xu, Junxiao Song, Xiao Bi, Haowei Zhang, Mingchuan Zhang, YK Li,
Yang Wu, et al. Deepseekmath: Pushing the limits of mathematical reasoning in open language models.arXiv preprint
arXiv:2402.03300, 2024.
Chengshuai Shi, Kun Yang, Jing Yang, and Cong Shen. Best arm identification for prompt learning under a limited
budget. arXiv preprint arXiv:2402.09723, 2024a.
Juanming Shi, Qinglang Guo, Yong Liao, and Shenglin Liang. Legalgpt: Legal chain of thought for the legal large
language model multi-agent framework. InInternational Conference on Intelligent Computing, pages 25–37. Springer,
2024b.
Noah Shinn, Federico Cassano, Ashwin Gopinath, Karthik Narasimhan, and Shunyu Yao. Reflexion: Language agents
with verbal reinforcement learning.Advances in Neural Information Processing Systems, 36:8634–8652, 2023.
Mohit Shridhar, Xingdi Yuan, Marc-Alexandre Côté, Yonatan Bisk, Adam Trischler, and Matthew J. Hausknecht.
Alfworld: Aligning text and embodied environments for interactive learning. In9th International Conference on
Learning Representations, 2021.
Arnav Singhvi, Manish Shetty, Shangyin Tan, Christopher Potts, Koushik Sen, Matei Zaharia, and Omar Khattab. Dspy
assertions: Computational constraints for self-refining language model pipelines.arXiv preprint arXiv:2312.13382,
2023.
Linxin Song, Jiale Liu, Jieyu Zhang, Shaokun Zhang, Ao Luo, Shijian Wang, Qingyun Wu, and Chi Wang. Adaptive
in-conversation team building for language model agents.arXiv preprint arXiv:2405.19425, 2024.
Dilara Soylu, Christopher Potts, and Omar Khattab.Fine-Tuning and Prompt Optimization: Two great steps that
work better together. InProceedings of the 2024 Conference on Empirical Methods in Natural Language Processing,
pages 10696–10710, 2024.
Olly Styles, Sam Miller, Patricio Cerda-Mardini, Tanaya Guha, Victor Sanchez, and Bertie Vidgen. Workbench: a
benchmark dataset for agents in a realistic workplace setting.arXiv preprint arXiv:2405.00823, 2024.
Jinwei Su, Yinghui Xia, Ronghua Shi, Jianhui Wang, Jianuo Huang, Yijin Wang, TIANYU SHI, Yang Jingsong, and
Lewei He. DebFlow: Automating agent creation via agent debate. InICML 2025 Workshop on Collaborative and
Federated Agentic Workflows, 2025.
Vighnesh Subramaniam, Yilun Du, Joshua B Tenenbaum, Antonio Torralba, Shuang Li, and Igor Mordatch. Multiagent
finetuning: Self improvement with diverse reasoning chains.arXiv preprint arXiv:2501.05707, 2025.
Emilio Sulis, Stefano Mariani, and Sara Montagna. A survey on agents applications in healthcare: Opportunities,
challenges and trends.Computer Methods and Programs in Biomedicine, 236:107525, 2023.
Hao Sun, Alihan Hüyük, and Mihaela van der Schaar.Query-Dependent prompt evaluation and optimization with
offline inverse RL. InThe Twelfth International Conference on Learning Representations, 2024a.
Jingyun Sun, Chengxiao Dai, Zhongze Luo, Yangbo Chang, and Yang Li.LawLuo: A Chinese law firm co-run byLLM
agents. arXiv preprint arXiv:2407.16252, 2024b.
Zeyi Sun, Ziyu Liu, Yuhang Zang, Yuhang Cao, Xiaoyi Dong, Tong Wu, Dahua Lin, and Jiaqi Wang.SEAgent:
Self-evolving computer use agent with autonomous learning from experience.arXiv preprint arXiv:2508.04700, 2025.
Yashar Talebirad and Amirhossein Nadiri. Multi-agent collaboration: Harnessing the power of intelligent llm agents.
arXiv preprint arXiv:2306.03314, 2023.
Xiangru Tang, Tianyu Hu, Muyang Ye, Yanjun Shao, Xunjian Yin, Siru Ouyang, Wangchunshu Zhou, Pan Lu, Zhuosheng
Zhang, Yilun Zhao, et al.ChemAgent: Self-updating memories in large language models improves chemical reasoning.
In The Thirteenth International Conference on Learning Representations, 2025a.
Xiangru Tang, Tianrui Qin, Tianhao Peng, Ziyang Zhou, Daniel Shao, Tingting Du, Xinming Wei, Peng Xia, Fang
Wu, He Zhu, et al. Agent kb: Leveraging cross-domain experience for agentic problem solving.arXiv preprint
arXiv:2507.06229, 2025b.
Xinyu Tang, Xiaolei Wang, Wayne Xin Zhao, Siyuan Lu, Yaliang Li, and Ji-Rong Wen. Unleashing the potential of large
language models as prompt optimizers: Analogical analysis with gradient-based model optimizers. InProceedings of
the AAAI Conference on Artificial Intelligence, pages 25264–25272, 2025c.
47

Xunzhu Tang, Kisub Kim, Yewei Song, Cedric Lothritz, Bei Li, Saad Ezzini, Haoye Tian, Jacques Klein, and Tegawendé F
Bissyandé. CodeAgent: Autonomous communicative agents for code review.arXiv preprint arXiv:2402.02172, 2024.
Yong-En Tian, Yu-Chien Tang, Kuang-Da Wang, An-Zi Yen, and Wen-Chih Peng. Template-based financial report
generation in agentic and decomposed information retrieval. InProceedings of the 48th International ACM SIGIR
Conference on Research and Development in Information Retrieval, pages 2706–2710. ACM, 2025.
Yuxuan Tong, Xiwen Zhang, Rui Wang, Ruidong Wu, and Junxian He. DART-math: Difficulty-aware rejection tuning
for mathematical problem-solving. InThe Thirty-eighth Annual Conference on Neural Information Processing Systems,
2024.
Khanh-Tung Tran, Dung Dao, Minh-Duong Nguyen, Quoc-Viet Pham, Barry O’Sullivan, and Hoang D Nguyen.
Multi-Agent collaboration mechanisms: A survey of LLMs.arXiv preprint arXiv:2501.06322, 2025.
Harsh Trivedi, Tushar Khot, Mareike Hartmann, Ruskin Manku, Vinty Dong, Edward Li, Shashank Gupta, Ashish
Sabharwal, and Niranjan Balasubramanian. Appworld: A controllable world of apps and people for benchmarking
interactive coding agents.arXiv preprint arXiv:2407.18901, 2024.
Miles Turpin, Julian Michael, Ethan Perez, and Samuel R. Bowman. Language models don’t always say what they
think: Unfaithful explanations in chain-of-thought prompting. InThirty-seventh Conference on Neural Information
Processing Systems, 2023.
Tycho FA van der Ouderaa, Markus Nagel, Mart Van Baalen, Yuki M Asano, and Tijmen Blankevoort. TheLLM
surgeon. arXiv preprint arXiv:2312.17244, 2023.
Pat Verga, Sebastian Hofstatter, Sophia Althammer, Yixuan Su, Aleksandra Piktus, Arkady Arkhangorodsky, Minjie
Xu, Naomi White, and Patrick Lewis. Replacing judges with juries: Evaluating llm generations with a panel of diverse
models. arXiv preprint arXiv:2404.18796, 2024.
Xingchen Wan, Han Zhou, Ruoxi Sun, and Sercan Ö. Arik. From few to many: Self-improving many-shot reasoners
through iterative optimization and generation. InThe Thirteenth International Conference on Learning Representations,
2025.
Boshi Wang, Hao Fang, Jason Eisner, Benjamin Van Durme, and Yu Su.LLMs in the imaginarium: Tool learning
through simulated trial and error. InProceedings of the 62nd Annual Meeting of the Association for Computational
Linguistics (Volume 1: Long Papers), pages 10583–10604, 2024a.
Guanzhi Wang, Yuqi Xie, Yunfan Jiang, Ajay Mandlekar, Chaowei Xiao, Yuke Zhu, Linxi Fan, and Anima Anandkumar.
Voyager: An open-ended embodied agent with large language models.Transactions on Machine Learning Research,
2023a.
Jize Wang, Ma Zerun, Yining Li, Songyang Zhang, Cailian Chen, Kai Chen, and Xinyi Le.GTA: a benchmark for general
tool agents. InThe Thirty-eight Conference on Neural Information Processing Systems Datasets and Benchmarks
Track, 2024b.
Junlin Wang, Jue WANG, Ben Athiwaratkun, Ce Zhang, and James Zou. Mixture-of-agents enhances large language
model capabilities. InThe Thirteenth International Conference on Learning Representations, 2025a.
Lei Wang, Chen Ma, Xueyang Feng, Zeyu Zhang, Hao Yang, Jingsen Zhang, Zhiyuan Chen, Jiakai Tang, Xu Chen,
Yankai Lin, et al. A survey on large language model based autonomous agents.Frontiers of Computer Science, 18(6):
186345, 2024c.
Ningning Wang, Xavier Hu, Pai Liu, He Zhu, Yue Hou, Heyuan Huang, Shengyu Zhang, Jian Yang, Jiaheng Liu,
Ge Zhang, Changwang Zhang, Jun Wang, Yuchen Eleanor Jiang, and Wangchunshu Zhou. Efficient agents: Building
effective agents while reducing cost, 2025b.
Peiyi Wang, Lei Li, Zhihong Shao, Runxin Xu, Damai Dai, Yifei Li, Deli Chen, Yu Wu, and Zhifang Sui. Math-shepherd:
Verify and reinforce llms step-by-step without human annotations. InProceedings of the 62nd Annual Meeting of the
Association for Computational Linguistics (Volume 1: Long Papers), pages 9426–9439, 2024d.
Qian Wang, Tianyu Wang, Zhenheng Tang, Qinbin Li, Nuo Chen, Jingsheng Liang, and Bingsheng He. All it takes is
one prompt: An autonomous LLM-MA system. InICLR 2025 Workshop on Foundation Models in the Wild, 2025c.
Qingyue Wang, Yanhe Fu, Yanan Cao, Shuai Wang, Zhiliang Tian, and Liang Ding. Recursively summarizing enables
long-term dialogue memory in large language models.Neurocomputing, 639:130193, 2025d.
Renxi Wang, Xudong Han, Lei Ji, Shu Wang, Timothy Baldwin, and Haonan Li.ToolGen: Unified tool retrieval and
calling via generation. InThe Thirteenth International Conference on Learning Representations, 2025e.
48

Shang Wang, Tianqing Zhu, Dayong Ye, and Wanlei Zhou. When machine unlearning meets retrieval-augmented
generation (RAG): Keep secret or forget knowledge?arXiv preprint arXiv:2410.15267, 2024e.
Shilong Wang, Guibin Zhang, Miao Yu, Guancheng Wan, Fanci Meng, Chongye Guo, Kun Wang, and Yang Wang.
G-Safeguard: A topology-guided security lens and treatment on llm-based multi-agent systems. InProceedings of the
63rd Annual Meeting of the Association for Computational Linguistics (Volume 1: Long Papers), pages 7261–7276,
2025f.
Siyuan Wang, Zhongyu Wei, Yejin Choi, and Xiang Ren. Symbolic working memory enhances language models for
complex rule application. InProceedings of the 2024 Conference on Empirical Methods in Natural Language Processing,
pages 17583–17604, 2024f.
Wenyi Wang, Hisham A Alyahya, Dylan R Ashley, Oleg Serikov, Dmitrii Khizbullin, Francesco Faccio, and Jürgen
Schmidhuber. How to correctly do semantic backpropagation on language-based agentic systems.arXiv preprint
arXiv:2412.03624, 2024g.
Xingyao Wang, Yangyi Chen, Lifan Yuan, Yizhe Zhang, Yunzhu Li, Hao Peng, and Heng Ji. Executable code actions
elicit better llm agents. InForty-first International Conference on Machine Learning, 2024h.
Xingyao Wang, Boxuan Li, Yufan Song, Frank F. Xu, Xiangru Tang, Mingchen Zhuge, Jiayi Pan, Yueqi Song, Bowen Li,
Jaskirat Singh, Hoang H. Tran, Fuqiang Li, Ren Ma, Mingzhang Zheng, Bill Qian, Yanjun Shao, Niklas Muennighoff,
Yizhe Zhang, Binyuan Hui, Junyang Lin, and et al.OpenHands: An open platform for AI software developers as
generalist agents. InThe Thirteenth International Conference on Learning Representations, 2025g.
Xinyuan Wang, Chenxi Li, Zhen Wang, Fan Bai, Haotian Luo, Jiayou Zhang, Nebojsa Jojic, Eric P. Xing, and Zhiting
Hu. PromptAgent: Strategic planning with language models enables expert-level prompt optimization. InThe Twelfth
International Conference on Learning Representations, 2024i.
Xuezhi Wang, Jason Wei, Dale Schuurmans, Quoc V. Le, Ed H. Chi, Sharan Narang, Aakanksha Chowdhery, and
Denny Zhou. Self-consistency improves chain of thought reasoning in language models. InThe Eleventh International
Conference on Learning Representations, 2023b.
Yingxu Wang, Shiqi Fan, Mengzhu Wang, and Siwei Liu. Dynamically adaptive reasoning viaLLM-guided mcts for
efficient and context-aware KGQA.arXiv preprint arXiv:2508.00719, 2025h.
Yingxu Wang, Siwei Liu, Jinyuan Fang, and Zaiqiao Meng.EvoAgentX: An automated framework for evolving agentic
workflows. arXiv preprint arXiv:2507.03616, 2025i.
Yinjie Wang, Ling Yang, Guohao Li, Mengdi Wang, and Bryon Aragam.ScoreFlow: Mastering llm agent workflows via
score-based preference optimization.arXiv preprint arXiv:2502.04306, 2025j.
Yiying Wang, Xiaojing Li, Binzhu Wang, Yueyang Zhou, Yingru Lin, Han Ji, Hong Chen, Jinshi Zhang, Fei Yu, Zewei
Zhao, et al. PEER: Expertizing domain-specific tasks with a multi-agent framework and tuning methods.arXiv
preprint arXiv:2407.06985, 2024j.
Yu Wang and Xi Chen.MIRIX: Multi-agent memory system for llm-based agents.arXiv preprint arXiv:2507.07957,
2025.
Zhiruo Wang, Graham Neubig, and Daniel Fried. TroVE: Inducing verifiable and efficient toolboxes for solving
programmatic tasks. InForty-first International Conference on Machine Learning, 2024k.
Zihan Wang, Kangrui Wang, Qineng Wang, Pingyue Zhang, Linjie Li, Zhengyuan Yang, Xing Jin, Kefan Yu, Minh Nhat
Nguyen, Licheng Liu, et al.RAGEN: Understanding self-evolution in llm agents via multi-turn reinforcement learning.
arXiv preprint arXiv:2504.20073, 2025k.
Ziyue Wang, Junde Wu, Chang Han Low, and Yueming Jin.MedAgent-Pro: Towards multi-modal evidence-based
medical diagnosis via reasoning agentic workflow.arXiv preprint arXiv:2503.18968, 2025l.
Zora Zhiruo Wang, Jiayuan Mao, Daniel Fried, and Graham Neubig. Agent workflow memory. InForty-second
International Conference on Machine Learning, 2024l.
Jason Wei, Xuezhi Wang, Dale Schuurmans, Maarten Bosma, Brian Ichter, Fei Xia, Ed H. Chi, Quoc V. Le, and Denny
Zhou. Chain-of-Thought prompting elicits reasoning in large language models. InAdvances in Neural Information
Processing Systems, 2022.
Jason Wei, Zhiqing Sun, Spencer Papay, Scott McKinney, Jeffrey Han, Isa Fulford, Hyung Won Chung, Alex Tachard
Passos, William Fedus, and Amelia Glaese.BrowseComp: A simple yet challenging benchmark for browsing agents.
arXiv preprint arXiv:2504.12516, 2025a.
49

Yangbo Wei, Zhen Huang, Huang Li, Wei W Xing, Ting-Jung Lin, and Lei He. Vflow: Discovering optimal agentic
workflows for verilog generation.arXiv preprint arXiv:2504.03723, 2025b.
Bin Wu, Edgar Meij, and Emine Yilmaz. A joint optimization framework for enhancing efficiency of tool utilization in
LLM agents. InFindings of the Association for Computational Linguistics, ACL, pages 22361–22373, 2025a.
Jialong Wu, Wenbiao Yin, Yong Jiang, Zhenglin Wang, Zekun Xi, Runnan Fang, Linhai Zhang, Yulan He, Deyu Zhou,
Pengjun Xie, and Fei Huang.WebWalker: Benchmarking llms in web traversal. InProceedings of the 63rd Annual
Meeting of the Association for Computational Linguistics (Volume 1: Long Papers), pages 10290–10305, 2025b.
Qingyun Wu, Gagan Bansal, Jieyu Zhang, Yiran Wu, Beibin Li, Erkang Zhu, Li Jiang, Xiaoyun Zhang, Shaokun Zhang,
Jiale Liu, et al. Autogen: Enabling next-gen llm applications via multi-agent conversations. InFirst Conference on
Language Modeling, 2024a.
Shirley Wu, Parth Sarthi, Shiyu Zhao, Aaron Lee, Herumb Shandilya, Adrian Mladenic Grobelnik, Nurendra Choudhary,
Eddie Huang, Karthik Subbian, Linjun Zhang, et al. Optimas: Optimizing compound ai systems with globally aligned
local rewards. arXiv preprint arXiv:2507.03041, 2025c.
Yurong Wu, Yan Gao, Bin Zhu, Zineng Zhou, Xiaodi Sun, Sheng Yang, Jian-Guang Lou, Zhiming Ding, and Linjun Yang.
StraGo: Harnessing strategic guidance for prompt optimization. InFindings of the Association for Computational
Linguistics: EMNLP, pages 10043–10061, 2024b.
Zhaofeng Wu, Linlu Qiu, Alexis Ross, Ekin Akyürek, Boyuan Chen, Bailin Wang, Najoung Kim, Jacob Andreas, and
Yoon Kim. Reasoning or reciting? exploring the capabilities and limitations of language models through counterfactual
tasks. In Proceedings of the 2024 Conference of the North American Chapter of the Association for Computational
Linguistics: Human Language Technologies (Volume 1: Long Papers), pages 1819–1862, 2024c.
Zhiheng Xi, Wenxiang Chen, Xin Guo, Wei He, Yiwen Ding, Boyang Hong, Ming Zhang, Junzhe Wang, Senjie Jin, Enyu
Zhou, Rui Zheng, Xiaoran Fan, Xiao Wang, Limao Xiong, Yuhao Zhou, Weiran Wang, Changhao Jiang, Yicheng Zou,
Xiangyang Liu, Zhangyue Yin, Shihan Dou, Rongxiang Weng, Wenjuan Qin, Yongyan Zheng, Xipeng Qiu, Xuanjing
Huang, Qi Zhang, and Tao Gui. The rise and potential of large language model based agents: a survey.Science China
Information Sciences, 68(2), 2025.
Jinyu Xiang, Jiayi Zhang, Zhaoyang Yu, Fengwei Teng, Jinhao Tu, Xinbing Liang, Sirui Hong, Chenglin Wu, and Yuyu
Luo. Self-supervised prompt optimization.arXiv preprint arXiv:2502.06855, 2025.
Tianbao Xie, Danyang Zhang, Jixuan Chen, Xiaochuan Li, Siheng Zhao, Ruisheng Cao, Toh J Hua, Zhoujun Cheng,
Dongchan Shin, Fangyu Lei, et al. Osworld: Benchmarking multimodal agents for open-ended tasks in real computer
environments. Advances in Neural Information Processing Systems, 37:52040–52094, 2024.
Huajian Xin, Daya Guo, Zhihong Shao, Zhizhou Ren, Qihao Zhu, Bo Liu, Chong Ruan, Wenda Li, and Xiaodan
Liang. Deepseek-prover: Advancing theorem proving in llms through large-scale synthetic data.arXiv preprint
arXiv:2405.14333, 2024.
Huajian Xin, Z.Z. Ren, Junxiao Song, Zhihong Shao, Wanjia Zhao, Haocheng Wang, Bo Liu, Liyue Zhang, Xuan Lu,
Qiushi Du, Wenjun Gao, Haowei Zhang, Qihao Zhu, Dejian Yang, Zhibin Gou, Z.F. Wu, Fuli Luo, and Chong Ruan.
Deepseek-prover-v1.5: Harnessing proof assistant feedback for reinforcement learning and monte-carlo tree search. In
The Thirteenth International Conference on Learning Representations, 2025.
Frank Xing. Designing heterogeneousLLM agents for financial sentiment analysis.ACM Transactions on Management
Information Systems, 16(1):1–24, 2025.
Hanwei Xu, Yujun Chen, Yulun Du, Nan Shao, Yanggang Wang, Haiyu Li, and Zhilin Yang.GPS: genetic prompt search
for efficient few-shot learning. InProceedings of the 2022 Conference on Empirical Methods in Natural Language
Processing, pages 8162–8171, 2022.
Qiantong Xu, Fenglu Hong, Bo Li, Changran Hu, Zhengyu Chen, and Jian Zhang. On the tool manipulation capability
of open-source large language models.arXiv preprint arXiv:2305.16504, 2023.
Tianqi Xu, Linyao Chen, Dai-Jie Wu, Yanjun Chen, Zecheng Zhang, Xiang Yao, Zhiqiang Xie, Yongchao Chen, Shilong
Liu, Bochen Qian, et al. Crab: Cross-environment agent benchmark for multimodal language model agents.arXiv
preprint arXiv:2407.01511, 2024a.
Tianwen Xu and Fengkui Ju. Multi-agent logic for reasoning about duties and powers in private law. InProceedings of
the Nineteenth International Conference on Artificial Intelligence and Law, pages 361–370, 2023.
Weijia Xu, Andrzej Banburski, and Nebojsa Jojic. Reprompting: Automated chain-of-thought prompt inference through
gibbs sampling. InForty-first International Conference on Machine Learning, 2024b.
50

Wujiang Xu, Kai Mei, Hang Gao, Juntao Tan, Zujie Liang, and Yongfeng Zhang.A-MEM: Agentic memory for llm
agents. arXiv preprint arXiv:2502.12110, 2025.
Sikuan Yan, Xiufeng Yang, Zuchao Huang, Ercong Nie, Zifeng Ding, Zonggen Li, Xiaowen Ma, Hinrich Schütze, Volker
Tresp, and Yunpu Ma.Memory-R1: Enhancing large language model agents to manage and utilize memories via
reinforcement learning. arXiv preprint arXiv:2508.19828, 2025.
An Yang, Anfeng Li, Baosong Yang, Beichen Zhang, Binyuan Hui, Bo Zheng, Bowen Yu, Chang Gao, Chengen Huang,
Chenxu Lv, et al. Qwen3 technical report.arXiv preprint arXiv:2505.09388, 2025a.
Chengrun Yang, Xuezhi Wang, Yifeng Lu, Hanxiao Liu, Quoc V. Le, Denny Zhou, and Xinyun Chen. Large language
models as optimizers. InThe Twelfth International Conference on Learning Representations, 2024a.
Hongyang Yang, Boyu Zhang, Neng Wang, Cheng Guo, Xiaoli Zhang, Likun Lin, Junlin Wang, Tianyu Zhou, Mao
Guan, Runjia Zhang, et al.FinRobot: an open-source ai agent platform for financial applications using large language
models. arXiv preprint arXiv:2405.14767, 2024b.
Ling Yang, Zhaochen Yu, Tianjun Zhang, Shiyi Cao, Minkai Xu, Wentao Zhang, Joseph E. Gonzalez, and Bin CUI. Buffer
of thoughts: Thought-augmented reasoning with large language models. InThe Thirty-eighth Annual Conference on
Neural Information Processing Systems, 2024c.
Rui Yang, Lin Song, Yanwei Li, Sijie Zhao, Yixiao Ge, Xiu Li, and Ying Shan.GPT4Tools: Teaching large language
model to use tools via self instruction. InAdvances in Neural Information Processing Systems, 2023.
Weiqing Yang, Hanbin Wang, Zhenghao Liu, Xinze Li, Yukun Yan, Shuo Wang, Yu Gu, Minghe Yu, Zhiyuan Liu, and
Ge Yu. Enhancing the code debugging ability of llms via communicative agent based data refinement.CoRR, 2024d.
Yingxuan Yang, Huacan Chai, Shuai Shao, Yuanyi Song, Siyuan Qi, Renting Rui, and Weinan Zhang.AgentNet:
Decentralized evolutionary coordination for llm-based multi-agent systems.arXiv preprint arXiv:2504.00587, 2025b.
Yingxuan Yang, Huacan Chai, Yuanyi Song, Siyuan Qi, Muning Wen, Ning Li, Junwei Liao, Haoyi Hu, Jianghao Lin,
Gaowei Chang, et al. A survey of AI agent protocols.arXiv preprint arXiv:2504.16736, 2025c.
Yingxuan Yang, Qiuying Peng, Jun Wang, Ying Wen, and Weinan Zhang. Unlocking the potential of decentralized llm-
based MAS: privacy preservation and monetization in collective intelligence. InProceedings of the 24th International
Conference on Autonomous Agents and Multiagent Systems, pages 2896–2900, 2025d.
Shunyu Yao, Dian Yu, Jeffrey Zhao, Izhak Shafran, Tom Griffiths, Yuan Cao, and Karthik Narasimhan. Tree of thoughts:
Deliberate problem solving with large language models.Advances in neural information processing systems, 36:
11809–11822, 2023a.
Shunyu Yao, Jeffrey Zhao, Dian Yu, Nan Du, Izhak Shafran, Karthik R Narasimhan, and Yuan Cao.ReAct: Synergizing
reasoning and acting in language models. InThe Eleventh International Conference on Learning Representations,
2023b.
Shunyu Yao, Noah Shinn, Pedram Razavi, and Karthik R Narasimhan.τ-bench: A benchmark forTool-Agent-User
interaction in real-world domains. InThe Thirteenth International Conference on Learning Representations, 2025.
Weiran Yao, Shelby Heinecke, Juan Carlos Niebles, Zhiwei Liu, Yihao Feng, Le Xue, Rithesh R. N., Zeyuan Chen,
Jianguo Zhang, Devansh Arpit, Ran Xu, Phil Mui, Huan Wang, Caiming Xiong, and Silvio Savarese. Retroformer:
Retrospective large language agents with policy gradient optimization. InThe Twelfth International Conference on
Learning Representations, 2024.
Qinyuan Ye, Maxamed Axmed, Reid Pryzant, and Fereshte Khani. Prompt engineering a prompt engineer.arXiv
preprint arXiv:2311.05661, 2023.
Rui Ye, Shuo Tang, Rui Ge, Yaxin Du, Zhenfei Yin, Siheng Chen, and Jing Shao.MAS-GPT: TrainingLLMs to build
LLM-based multi-agent systems.arXiv preprint arXiv:2503.03686, 2025.
Asaf Yehudai, Lilach Eden, Alan Li, Guy Uziel, Yilun Zhao, Roy Bar-Haim, Arman Cohan, and Michal Shmueli-Scheuer.
Survey on evaluation of LLM-based agents.arXiv preprint arXiv:2503.16416, 2025.
Fan Yin, Zifeng Wang, I Hsu, Jun Yan, Ke Jiang, Yanfei Chen, Jindong Gu, Long T Le, Kai-Wei Chang, Chen-
Yu Lee, et al. Magnet: Multi-turn tool-use data synthesis and distillation via graph translation.arXiv preprint
arXiv:2503.07826, 2025.
Shuo Yin, Weihao You, Zhilong Ji, Guoqiang Zhong, and Jinfeng Bai.MuMath-Code: Combining tool-use large language
models with multi-perspective data augmentation for mathematical reasoning. InProceedings of the 2024 Conference
on Empirical Methods in Natural Language Processing, pages 4770–4785, 2024.
51

Zhangyue Yin, Qiushi Sun, Cheng Chang, Qipeng Guo, Junqi Dai, Xuanjing Huang, and Xipeng Qiu.
Exchange-of-Thought: Enhancing large language model capabilities through cross-model communication. InProceed-
ings of the 2023 Conference on Empirical Methods in Natural Language Processing, pages 15135–15153, 2023.
Junwei Yu, Yepeng Ding, and Hiroyuki Sato.DynTaskMAS: A dynamic task graph-driven framework for asynchronous
and parallel LLM-based multi-agent systems.arXiv preprint arXiv:2503.07675, 2025.
Miao Yu, Shilong Wang, Guibin Zhang, Junyuan Mao, Chenlong Yin, Qijiong Liu, Qingsong Wen, Kun Wang, and Yang
Wang. NetSafe: Exploring the topological safety of multi-agent networks.arXiv preprint arXiv:2410.15686, 2024a.
Yangyang Yu, Zhiyuan Yao, Haohang Li, Zhiyang Deng, Yuechen Jiang, Yupeng Cao, Zhi Chen, Jordan Suchow, Zhenyu
Cui, Rong Liu, et al. Fincon: A synthesized llm multi-agent system with conceptual verbal reinforcement for enhanced
financial decision making.Advances in Neural Information Processing Systems, 37:137010–137045, 2024b.
Lifan Yuan, Yangyi Chen, Xingyao Wang, Yi Fung, Hao Peng, and Heng Ji. CRAFT: Customizing LLMs by creating
and retrieving from specialized toolsets. InThe Twelfth International Conference on Learning Representations, 2024a.
Siyu Yuan, Kaitao Song, Jiangjie Chen, Xu Tan, Dongsheng Li, and Deqing Yang.EvoAgent: Towards automatic
multi-agent generation via evolutionary algorithms. InProceedings of the 2025 Conference of the Nations of the
Americas Chapter of the Association for Computational Linguistics: Human Language Technologies, pages 6192–6217,
2025a.
Siyu Yuan, Kaitao Song, Jiangjie Chen, Xu Tan, Yongliang Shen, Kan Ren, Dongsheng Li, and Deqing Yang.EASYTOOL:
enhancing llm-based agents with concise tool instruction. InProceedings of the 2025 Conference of the Nations of the
Americas Chapter of the Association for Computational Linguistics: Human Language Technologies, pages 951–972,
2025b.
Tongxin Yuan, Zhiwei He, Lingzhong Dong, Yiming Wang, Ruijie Zhao, Tian Xia, Lizhen Xu, Binglin Zhou, Fangqi Li,
Zhuosheng Zhang, et al. R-judge: Benchmarking safety risk awareness for llm agents.arXiv preprint arXiv:2401.10019,
2024b.
Weikang Yuan, Junjie Cao, Zhuoren Jiang, Yangyang Kang, Jun Lin, Kaisong Song, Pengwei Yan, Changlong Sun,
Xiaozhong Liu, et al. Can large language models grasp legal theories? enhance legal reasoning with insights from
multi-agent collaboration. arXiv preprint arXiv:2410.02507, 2024c.
Weizhe Yuan, Richard Yuanzhe Pang, Kyunghyun Cho, Xian Li, Sainbayar Sukhbaatar, Jing Xu, and Jason Weston.
Self-rewarding language models. InForty-first International Conference on Machine Learning, 2024d.
Mert Yuksekgonul, Federico Bianchi, Joseph Boen, Sheng Liu, Zhi Huang, Carlos Guestrin, and James Zou. Textgrad:
Automatic “differentiation” via text.arXiv preprint arXiv:2406.07496, 2024.
Mert Yüksekgönül, Federico Bianchi, Joseph Boen, Sheng Liu, Pan Lu, Zhi Huang, Carlos Guestrin, and James Zou.
Optimizing generative AI by backpropagating language model feedback.Nature, 639(8055):609–616, 2025.
Eric Zelikman, Yuhuai Wu, Jesse Mu, and Noah Goodman.STaR: Bootstrapping reasoning with reasoning. InAdvances
in Neural Information Processing Systems, volume 35, pages 15476–15488, 2022.
Ruihong Zeng, Jinyuan Fang, Siwei Liu, and Zaiqiao Meng. On the structural memory of llm agents.arXiv preprint
arXiv:2412.15266, 2024a.
Ruihong Zeng, Jinyuan Fang, Siwei Liu, and Zaiqiao Meng. On the structural memory of llm agents.arXiv preprint
arXiv:2412.15266, 2024b.
Alexander Zhang, Marcus Dong, Jiaheng Liu, Wei Zhang, Yejie Wang, Jian Yang, Ge Zhang, Tianyu Liu, Zhongyuan
Peng, Yingshui Tan, et al.CodeCriticBench: A holistic code critique benchmark for large language models.arXiv
preprint arXiv:2502.16614, 2025a.
Chi Zhang, Zhao Yang, Jiaxuan Liu, Yanda Li, Yucheng Han, Xin Chen, Zebiao Huang, Bin Fu, and Gang Yu.AppAgent:
Multimodal agents as smartphone users. InProceedings of the 2025 CHI Conference on Human Factors in Computing
Systems, pages 70:1–70:20. ACM, 2025b.
Dan Zhang, Sining Zhoubian, Min Cai, Fengzu Li, Lekang Yang, Wei Wang, Tianjiao Dong, Ziniu Hu, Jie Tang, and
Yisong Yue. DataSciBench: An llm agent benchmark for data science.arXiv preprint arXiv:2502.13897, 2025c.
Enhao Zhang, Erkang Zhu, Gagan Bansal, Adam Fourney, Hussein Mozannar, and Jack Gerrits. Optimizing sequential
multi-step tasks with parallel llm agents.arXiv preprint arXiv:2507.08944, 2025d.
52

Guibin Zhang, Yanwei Yue, Xiangguo Sun, Guancheng Wan, Miao Yu, Junfeng Fang, Kun Wang, Tianlong Chen, and
Dawei Cheng. G-designer: Architecting multi-agent communication topologies via graph neural networks.arXiv
preprint arXiv:2410.11782, 2024a.
Guibin Zhang, Muxin Fu, Guancheng Wan, Miao Yu, Kun Wang, and Shuicheng Yan.G-Memory: Tracing hierarchical
memory for multi-agent systems.arXiv preprint arXiv:2506.07398, 2025e.
Guibin Zhang, Luyang Niu, Junfeng Fang, Kun Wang, LEI BAI, and Xiang Wang. Multi-agent architecture search via
agentic supernet. InForty-second International Conference on Machine Learning, 2025f.
Guibin Zhang, Yanwei Yue, Zhixun Li, Sukwon Yun, Guancheng Wan, Kun Wang, Dawei Cheng, Jeffrey Xu Yu, and
Tianlong Chen. Cut the crap: An economical communication pipeline for llm-based multi-agent systems. InThe
Thirteenth International Conference on Learning Representations, 2025g.
Hangfan Zhang, Zhiyao Cui, Xinrun Wang, Qiaosheng Zhang, Zhen Wang, Dinghao Wu, and Shuyue Hu. If multi-agent
debate is the answer, what is the question.arXiv preprint arXiv:2502.08788, 2025h.
Jenny Zhang, Shengran Hu, Cong Lu, Robert Lange, and Jeff Clune. Darwin godel machine: Open-ended evolution of
self-improving agents.arXiv preprint arXiv:2505.22954, 2025i.
Jiayi Zhang, Jinyu Xiang, Zhaoyang Yu, Fengwei Teng, Xiong-Hui Chen, Jiaqi Chen, Mingchen Zhuge, Xin Cheng, Sirui
Hong, Jinlin Wang, Bingnan Zheng, Bang Liu, Yuyu Luo, and Chenglin Wu.AFlow: Automating agentic workflow
generation. In The Thirteenth International Conference on Learning Representations, 2025j.
Jun Zhang, Yuwei Yan, Junbo Yan, Zhiheng Zheng, Jinghua Piao, Depeng Jin, and Yong Li. A parallelized framework
for simulating large-scale LLM agents with realistic environments and interactions. In Georg Rehm and Yunyao
Li, editors, Proceedings of the 63rd Annual Meeting of the Association for Computational Linguistics (Volume 6:
Industry Track), pages 1339–1349, Vienna, Austria, July 2025k. Association for Computational Linguistics. ISBN
979-8-89176-288-6. doi: 10.18653/v1/2025.acl-industry.94.
Kechi Zhang, Zhuo Li, Jia Li, Ge Li, and Zhi Jin.Self-Edit: Fault-aware code editor for code generation.arXiv preprint
arXiv:2305.04087, 2023a.
Peiyan Zhang, Haibo Jin, Leyang Hu, Xinnuo Li, Liying Kang, Man Luo, Yangqiu Song, and Haohan Wang. Revolve:
Optimizing AI systems by tracking response evolution in textual optimization. InForty-second International Conference
on Machine Learning, 2025l.
Shaokun Zhang, Jieyu Zhang, Jiale Liu, Linxin Song, Chi Wang, Ranjay Krishna, and Qingyun Wu. Offline training
of language model agents with functions as learnable weights. InForty-first International Conference on Machine
Learning, 2024b.
Shaokun Zhang, Yi Dong, Jieyu Zhang, Jan Kautz, Bryan Catanzaro, Andrew Tao, Qingyun Wu, Zhiding Yu, and
Guilin Liu. Nemotron-research-tool-n1: Tool-using language models with reinforced reasoning. arXiv preprint
arXiv:2505.00024, 2025m.
Tianjun Zhang, Xuezhi Wang, Denny Zhou, Dale Schuurmans, and Joseph E. Gonzalez.TEMPERA: test-time prompt
editing via reinforcement learning. InThe Eleventh International Conference on Learning Representations, 2023b.
Wentao Zhang, Ce Cui, Yilei Zhao, Rui Hu, Yang Liu, Yahui Zhou, and Bo An. Agentorchestra: A hierarchical
multi-agent framework for general-purpose task solving.arXiv preprint arXiv:2506.12508, 2025n.
Yusen Zhang, Ruoxi Sun, Yanfei Chen, Tomas Pfister, Rui Zhang, and Sercan Arik. Chain of agents: Large language
models collaborating on long-context tasks.Advances in Neural Information Processing Systems, 37:132208–132237,
2024c.
Zeyu Zhang, Quanyu Dai, Xiaohe Bo, Chen Ma, Rui Li, Xu Chen, Jieming Zhu, Zhenhua Dong, and Ji-Rong Wen. A
survey on the memory mechanism of large language model based agents.ACM Transactions on Information Systems,
2024d.
Andrew Zhao, Daniel Huang, Quentin Xu, Matthieu Lin, Yong-Jin Liu, and Gao Huang.ExpeL: LLM agents are
experiential learners. InProceedings of the AAAI Conference on Artificial Intelligence, pages 19632–19642, 2024.
Andrew Zhao, Yiran Wu, Yang Yue, Tong Wu, Quentin Xu, Matthieu Lin, Shenzhi Wang, Qingyun Wu, Zilong Zheng,
and Gao Huang. Absolute Zero: Reinforced self-play reasoning with zero data.arXiv preprint arXiv:2505.03335,
2025a.
53

Ruochen Zhao, Wenxuan Zhang, Yew Ken Chia, Weiwen Xu, Deli Zhao, and Lidong Bing.Auto-Arena: Automating
LLM evaluations with agent peer battles and committee discussions. InProceedings of the 63rd Annual Meeting of the
Association for Computational Linguistics (Volume 1: Long Papers), pages 4440–4463, 2025b.
Wanjia Zhao, Mert Yuksekgonul, Shirley Wu, and James Zou.SiriuS: Self-improving multi-agent systems via bootstrapped
reasoning. arXiv preprint arXiv:2502.04780, 2025c.
Wayne Xin Zhao, Kun Zhou, Junyi Li, Tianyi Tang, Xiaolei Wang, Yupeng Hou, Yingqian Min, Beichen Zhang, Junjie
Zhang, Zican Dong, et al. A survey of large language models.arXiv preprint arXiv:2303.18223, 1(2), 2023.
Chengqi Zheng, Jianda Chen, Yueming Lyu, Wen Zheng Terence Ng, Haopeng Zhang, Yew-Soon Ong, Ivor Tsang, and
Haiyan Yin. Mermaidflow: Redefining agentic workflow generation via safety-constrained evolutionary programming.
arXiv preprint arXiv:2505.22967, 2025.
Longtao Zheng, Rundong Wang, Xinrun Wang, and Bo An. Synapse: Trajectory-as-exemplar prompting with memory
for computer control. InThe Twelfth International Conference on Learning Representations, 2023a.
Sipeng Zheng, Jiazheng Liu, Yicheng Feng, and Zongqing Lu.Steve-Eye: Equipping llm-based embodied agents with
visual perception in open worlds. InThe Twelfth International Conference on Learning Representations, 2024.
Zhiling Zheng, Oufan Zhang, Ha L Nguyen, Nakul Rampal, Ali H Alawadhi, Zichao Rong, Teresa Head-Gordon, Christian
Borgs, Jennifer T Chayes, and Omar M Yaghi. Chatgpt research group for optimizing the crystallinity of mofs and
cofs. ACS Central Science, 9(11):2161–2170, 2023b.
Wanjun Zhong, Lianghong Guo, Qiqi Gao, He Ye, and Yanlin Wang. Memorybank: Enhancing large language models
with long-term memory. InProceedings of the AAAI Conference on Artificial Intelligence, pages 19724–19731, 2024.
Han Zhou, Xingchen Wan, Ivan Vulic, and Anna Korhonen. Survival of the most influential prompts: Efficient black-box
prompt search via clustering and pruning. InFindings of the Association for Computational Linguistics: EMNLP,
pages 13064–13077, 2023a.
Han Zhou, Xingchen Wan, Yinhong Liu, Nigel Collier, Ivan Vulić, and Anna Korhonen. Fairer preferences elicit improved
human-aligned large language model judgments. In Yaser Al-Onaizan, Mohit Bansal, and Yun-Nung Chen, editors,
Proceedings of the 2024 Conference on Empirical Methods in Natural Language Processing, pages 1241–1252, Miami,
Florida, USA, November 2024a. Association for Computational Linguistics.
Han Zhou, Xingchen Wan, Lev Proleev, Diana Mincu, Jilin Chen, Katherine A Heller, and Subhrajit Roy. Batch
calibration: Rethinking calibration for in-context learning and prompt engineering. InThe Twelfth International
Conference on Learning Representations, 2024b.
Han Zhou, Xingchen Wan, Ruoxi Sun, Hamid Palangi, Shariq Iqbal, Ivan Vulić, Anna Korhonen, and Sercan Ö Arık.
Multi-Agent design: Optimizing agents with better prompts and topologies.arXiv preprint arXiv:2502.02533, 2025a.
Huichi Zhou, Yihang Chen, Siyuan Guo, Xue Yan, Kin Hei Lee, Zihan Wang, Ka Yiu Lee, Guchun Zhang, Kun Shao,
Linyi Yang, et al. Memento: Fine-tuning llm agents without fine-tuning llms.arXiv preprint arXiv:2508.16153, 2025b.
Shuyan Zhou, Frank F Xu, Hao Zhu, Xuhui Zhou, Robert Lo, Abishek Sridhar, Xianyi Cheng, Tianyue Ou, Yonatan
Bisk, Daniel Fried, et al. Webarena: A realistic web environment for building autonomous agents.arXiv preprint
arXiv:2307.13854, 2023b.
Wangchunshu Zhou, Yixin Ou, Shengwei Ding, Long Li, Jialong Wu, Tiannan Wang, Jiamin Chen, Shuai Wang, Xiaohua
Xu, Ningyu Zhang, et al. Symbolic learning enables self-evolving agents.arXiv preprint arXiv:2406.18532, 2024c.
Yongchao Zhou, Andrei Ioan Muresanu, Ziwen Han, Keiran Paster, Silviu Pitis, Harris Chan, and Jimmy Ba. Large lan-
guage models are human-level prompt engineers. InThe Eleventh International Conference on Learning Representations,
2023c.
Zijian Zhou, Ao Qu, Zhaoxuan Wu, Sunghwan Kim, Alok Prakash, Daniela Rus, Jinhua Zhao, Bryan Kian Hsiang Low,
and Paul Pu Liang.MEM1: Learning to synergize memory and reasoning for efficient long-horizon agents.arXiv
preprint arXiv:2506.15841, 2025c.
Kunlun Zhu, Hongyi Du, Zhaochen Hong, Xiaocheng Yang, Shuyi Guo, Zhe Wang, Zhenhailong Wang, Cheng Qian,
Xiangru Tang, Heng Ji, et al.MultiAgentBench: Evaluating the collaboration and competition of llm agents.arXiv
preprint arXiv:2503.01935, 2025.
Tinghui Zhu, Kai Zhang, Jian Xie, and Yu Su. Deductive beam search: Decoding deducible rationale for chain-of-thought
reasoning. In First Conference on Language Modeling, 2024.
54

Xinyu Zhu, Junjie Wang, Lin Zhang, Yuxiang Zhang, Yongfeng Huang, Ruyi Gan, Jiaxing Zhang, and Yujiu Yang.
Solving math word problems via cooperative reasoning induced language models. InProceedings of the 61st Annual
Meeting of the Association for Computational Linguistics (Volume 1: Long Papers). Association for Computational
Linguistics (ACL), 2023.
Yangyang Zhuang, Wenjia Jiang, Jiayu Zhang, Ze Yang, Joey Tianyi Zhou, and Chi Zhang. Learning to be a doctor:
Searching for effective medical agent architectures.arXiv preprint arXiv:2504.11301, 2025.
Yuchen Zhuang, Yue Yu, Kuan Wang, Haotian Sun, and Chao Zhang.ToolQA: A dataset forLLM question answering
with external tools. InAdvances in Neural Information Processing Systems, 2023.
Yuchen Zhuang, Xiang Chen, Tong Yu, Saayan Mitra, Victor Bursztyn, Ryan A Rossi, Somdeb Sarkhel, and Chao Zhang.
Toolchain*: Efficient action space navigation in large language models with a* search. InThe Twelfth International
Conference on Learning Representations, 2024.
Mingchen Zhuge, Wenyi Wang, Louis Kirsch, Francesco Faccio, Dmitrii Khizbullin, and Jürgen Schmidhuber. GPTSwarm:
Language agents as optimizable graphs. InForty-first International Conference on Machine Learning, 2024a.
Mingchen Zhuge, Changsheng Zhao, Dylan Ashley, Wenyi Wang, Dmitrii Khizbullin, Yunyang Xiong, Zechun Liu, Ernie
Chang, Raghuraman Krishnamoorthi, Yuandong Tian, et al. Agent-as-a-judge: Evaluate agents with agents.arXiv
preprint arXiv:2410.10934, 2024b.
Huhai Zou, Rongzhen Li, Tianhao Sun, Fei Wang, Tao Li, and Kai Liu. Cooperative scheduling and hierarchical memory
model for multi-agent systems. In2024 IEEE International Symposium on Product Compliance Engineering - Asia
(ISPCE-ASIA), pages 1–6, 2024. doi: 10.1109/ISPCE-ASIA64773.2024.10756271.
Kaiwen Zuo, Yirui Jiang, Fan Mo, and Pietro Lio.KG4Diagnosis: A hierarchical multi-agentLLM framework with
knowledge graph enhancement for medical diagnosis. InAAAI Bridge Program on AI for Medicine and Healthcare,
pages 195–204. PMLR, 2025.
55
