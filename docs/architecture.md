# Tracewise · 系统技术设计

系统技术设计文档
本文档为MVP阶段文档，用于指导MVP版本的开发实现。
MVP版本聚焦核心业务闭环，暂不包含非必要的扩展能力，后续迭代再补充完善。

项目: Collaborative Candidate Verification Web App
版本：V1.0.0
最后更新：2026.9.20
作者：Nirvana

1. 技术架构 (System Architecture)
1.1 架构概览
• 本系统采用 Vercel + Render + Supabase 的混合架构。
• 核心技术栈清单


采用 Background Worker 执行长任务的核心原因，是避免 Vercel Serverless Function 的请求持续时
间限制影响长时间的面试分析任务。
1.2 模块调用关系
• 普通业务操作：

  代码块
  1 用户
  2    ↓
  3    Frontend
  4    ↓
  5    Vercel API
  6    ↓
  7    Supabase Database / Storage


• AI 长任务：

  代码块
  1 用户操作
  2    ↓
  3    Frontend
  4    ↓
  5    Vercel API
  6    ↓
  7    创建 ai_task
  8    ↓
  9    立即返回 task_id + pending
  10   ↓
  11   Queue
  12   ↓
  13   Background Worker
  14   ↓
  15   根据 task_type 执行对应 Mastra Workflow
  16   ↓
  17   LLM / RAG
  18   ↓
  19   Database / Storage
  20   ↓
  21   Supabase Realtime


 22   ↓
 23   Frontend


• AI 流式对话：

  代码块
  1   Frontend
  2   ↓
  3   Streaming LLM API
  4   ↓
  5   LLM
  6   ↓
  7   Stream
  8   ↓
  9   Frontend


Worker 最大并发数设置为 2，最多同时处理两个 AI 长任务。
1.3 数据流
• 核心 AI 数据流：

  代码块
  1 用户输入
  2   ↓
  3   Frontend
  4   ↓
  5   Vercel API
  6   ↓
  7   创建 AI Task
  8   ↓
  9   Queue
 10   ↓
 11   Worker
 12   ↓
 13   读取 Database / Storage
 14   ↓
 15   Mastra Workflow
 16   ↓
 17   必要时检索 pgvector
 18   ↓
 19   LLM Call
 20   ↓
 21   Structured Output


 22   ↓
 23   Database / Snapshot
 24   ↓
 25   Realtime
 26   ↓
 27   Frontend


• 企业知识库建立流程：

  代码块
  1 企业资料上传
  2   ↓
  3   Supabase Storage
  4   ↓
  5   文件解析
  6   ↓
  7   文本切分 Chunk
  8   ↓
  9   Embedding
 10   ↓
 11   Supabase pgvector


1.4 外部依赖
MVP 使用的主要外部依赖：


2. AI集成设计 (AI Integration)
2.1 AI调用链路


系统根据任务类型采用不同调用方式：


如果单个 LLM 在速度、成本和效果上均能满足任务要求，则优先使用同一个 LLM，不为了区分轻量模
型/强模型而增加不必要的模型复杂度。
2.1.1 Mastra 任务状态
Mastra 异步任务整体生命周期状态： pending → processing → completed / failed 
• pending：任务已创建，等待调度执行
• processing：Mastra 已经开始执行业务流程
• completed：全流程执行完毕，业务结果已持久化保存
• failed：出现不可恢复错误、用尽最大重试次数、触发整体任务超时，任务终止
 说明：该状态描述整个 Mastra Task 任务，不是单个 LLM Call 的执行状态。
2.1.2 超时设置
采用单 Call 超时 + 整体任务超时双层超时机制
• 单 Call 超时：每个独立 LLM Call 设置最大执行时间，设计参考范围 20‑30 秒。单次调用超时，若
  整体任务未到最大时限，允许按照重试策略重试。单 Call 耗尽最大重试次数依旧失败，任务直接置
  为 failed。
 注：20‑30s 为设计区间，开发阶段依据线上真实响应确定最终数值，不硬编码。
• 整体任务超时：整个 Mastra Task 最大执行时间 120 秒。一旦到达整体任务超时阈值，无论当前处
  于哪一次 Call、哪一轮重试，直接终止任务，标记为 failed，不再发起后续调用。
2.1.3 重试策略
重试仅用于临时性、具备恢复可能性的异常，并非所有失败都执行重试。最大重试次数：2 次；重试等
待采用递增等待：失败后等待 2s 执行第 1 次重试；失败后等待 5s 执行第 2 次重试；重试依旧失败则
任务失败。


 约束：即便重试次数未用尽，只要触发整体任务 120 秒超时，立刻停止重试。
• 可重试错误：
  ◦ LLM API 网络 / 服务异常：策略：递增等待重试
  ◦ LLM 请求超时：策略：递增等待重试
  ◦ Structured Output 结构校验失败：策略：递增等待重试
  ◦ RAG/pgvector 可恢复调用异常：策略：递增等待重试
• 不可重试错误（命中直接终止任务进入 failed）：
  ◦ 风控拦截内容；
  ◦ 乱码、空白等无有效输入；
  ◦ 结构化输出识别不到有效业务信息；
  ◦ 达到整体任务最大执行时间；
  ◦ 达到最大重试次数。
判断原则：输入本身无效、业务层面重试无法解决问题、系统资源边界到达，一律不重试。
2.1.4 RAG 无有效召回结果的处理
区分两种 RAG 异常场景：
• pgvector 调用异常；
• pgvector 调用正常但是无有效召回结果。 
针对调用正常、无有效企业资料召回的场景执行降级逻辑： 生成检索 Query → pgvector 检索执行成
功，无有效召回 → 日志标记企业知识依据不足 → 复用已有 JD / 项目数据继续业务分析 → 继续执行后
续 LLM 调用。
后台记录检索上下文、知识库依据不足标记，用于后续知识库覆盖度排查。
2.2 上下文管理
2.2.1 会话状态
采用有状态管理。
AI 对话的历史消息保存于 Database，调用时根据当前 conversation_id 获取所需历史消息。
AI Task 则通过 task_id 管理异步任务状态。
前端状态：
  代码块
  1   pending
  2   ↓


  3   processing
  4   ↓
  5   completed / failed


后台可以存在 retrying ，但 Retry 不向用户暴露为独立状态；Retry 时前端继续显示
processing ，并显示：

 遇到临时问题，正在自动重试…
2.2.2 Token 用量控制
MVP 阶段采用以下方式：
• 优先直接读取 Database 中已经生成的结构化结果，不重复调用 LLM。 
• 不对每个业务动作预设固定 Token 消耗值。 
• 控制输入上下文，避免重复传递无关历史内容。 
• 通过复用前序 Call 结果减少重复分析。 
不同任务的 Token 消耗取决于实际输入和输出，因此当前阶段不建立复杂的成本模型。
2.2.3 历史消息处理
AI 对话采用：
  代码块
  1 当前用户消息
  2   +
  3   必要的历史消息
  4   +
  5   当前项目 / 候选人 / 面试轮次上下文

当历史消息过长时，只保留当前任务需要的上下文，避免无意义地将全部历史重新发送给 LLM。
2.3 成本与性能
MVP 阶段不制定固定 Token 预算、P95 性能指标或复杂限流模型。
原因是目前项目仍处于 MVP 开发阶段，真实输入长度、LLM 调用次数和实际运行耗时尚未通过测试获
得可靠数据。
当前主要采用：
• 减少重复 LLM Call； 
• 直接读取已有分析结果； 


• 异步处理长任务； 
• Worker 并发数限制为 2； 
• 对失败任务进行有限次数 Retry； 
• 对 LLM 超时进行记录。 
后续实际测试获得 Token、耗时和失败率数据后，再根据实际运行结果调整成本与性能策略。
2.4 失败处理与监控
LLM Call 失败时由 Worker 进行 Retry。
    代码块
    1   Call
    2   ↓
    3   失败
    4   ↓
    5   Retry
    6   ↓
    7   成功 → 继续 Workflow
    8   ↓
    9   仍失败 → Task failed

Worker 每次 Retry 记录：
    代码块
    1   task_id
    2   retry_count
    3   error


同时记录：
• 单 Call 是否超时； 
• 整体 Task 是否超时； 
• 当前 Task 状态； 
• pgvector 是否正常检索； 
• 最终错误信息； 
• 最终生成的 Snapshot ID。 
短时间大量任务进入 Retry 状态时，通过日志 / 监控告警发现 LLM 服务异常。


3. 数据库设计 (Database Schema)
系统数据库主要用于存储业务实体、实体之间的关联关系、AI 分析结构化结果及用户交互数据；生成
的简历、逐字稿、标注文件、单轮面试总结表、候选人总总结表等文件存储于 Supabase Storage，数
据库保存对应的文件路径及关联信息。
3.1 表结构定义
3.1.1 users 用户表


3.1.2 projects 项目表


3.1.3 project_users 项目角色关系表


3.1.4 candidates 候选人表


3.1.5 interview_rounds 面试轮次表


已经确定的规则：轮次固定，analysis_version 不负责表示轮次。
3.1.6 interview_analysis_snapshot 分析快照表


快照直接保存多个关联关系，方便后台回溯和调试；前端只展示最新版本。
3.1.7 ai_tasks AI 任务表


这里前端只显示：
pending → processing → completed / failed   
后台可以存在 retrying，但不作为前端状态。
3.1.8 conversations 对话表


3.1.9 conversation_messages 对话消息表


3.1.10 files 文件表


3.2 表关系说明
  代码块
  1                        （      ）
      User 1 : N Project created_by 
  2   
  3   Project N : M User
  4           ↓
  5       project_users
  6           ↓
  7          role
  8   


  9   Project 1 : N Candidate
 10   
 11   Candidate 1 : N InterviewRound
 12   
 13   InterviewRound 1 : N InterviewAnalysisSnapshot
 14   
 15   InterviewRound 1 : N AITask
 16   
 17   InterviewRound 1 : 1 Conversation
 18   
 19   Conversation 1 : N ConversationMessage
 20   
 21   Project / Candidate / InterviewRound / Conversation
 22            ↓
 23        Files


重要点： ai_tasks → interview_analysis_snapshot 是 Task 找 Snapshot，不反过来依
赖 Snapshot 找 Task。

3.3 数据生命周期
  代码块
  1 用户创建项目
  2   ↓
  3   创建 Project、Project User 关系
  4   ↓
  5   创建 Candidate
  6   ↓
  7   上传并保存简历文件
  8   ↓
  9   进入面试准备轮（round_no = 0）
 10   ↓
 11   触发 AI 分析
 12   ↓
 13   创建 AI Task
 14   ↓
 15   Worker   执行 Mastra Workflow
 16   ↓
 17   生成分析结果
 18   ↓
 19   写入 interview_analysis_snapshot
 20   ↓
 21   前端通过 Realtime 获取任务结果


22       ↓
23       用户开始第一轮面试
24       ↓
25       创建下一轮 Interview Round
26       ↓
27       上传面试记录
28       ↓
29       触发面试分析
30       ↓
31       生成新的 Analysis Snapshot
32       ↓
33       轮次结束并记录面试状态
34       ↓
35       进入下一轮

前端业务删除只改变业务可见性，相关记录和文件后台保留；已经开始或结束的面试不能通过普通项
目成员直接删除。
已完成的面试轮次不会回退重新修改分析结果；新的分析版本只在当前轮次允许重新生成的情况下产
生。
候选人删除采用业务删除、后台保留的方式。候选人仅允许在正式一面开始之前由项目创建者执行
删除；删除后，候选人及其关联的分析快照、AI 对话记录、相关文件等在前端业务界面不可见，但
后台数据库及 Storage 中仍保留，用于内部查询及调试。
面试开始后，普通删除操作不可用。如需更换承接人员，通过候选人转移机制将候选人与对应面试角
色转移给其他项目成员；原用户侧对应业务记录移除，承接用户侧显示该候选人的面试记录。

项目删除不采用立即物理删除。
用户执行业务删除后：
     代码块
     1 前端不可见
     2           ↓
     3    业务删除标记
     4           ↓
     5    后台数据仍保留

候选人、分析快照及相关文件跟随候选人的业务删除标记变为不可见，但后台保留，以便开发调试及
问题追踪。
项目/候选人的具体删除和转移权限由：


   代码块Auth 身份
   1
   2   +
   3   Project ↔ User   关系
   4   +
   5   项目角色

 共同判断。


4. 安全设计 (Security Design)
4.1 RLS 规则
采用 Supabase RLS 控制数据库访问权限。核心原则不是简单的“ auth.uid() = user_id ”，
而是根据数据归属关系判断用户是否有权访问。
• users ：用户只能读取、修改自己的个人信息。 
• projects ：项目创建人及项目成员只能访问自己所属项目；项目删除后前端不可见。 
• project_users ：只有项目创建人或管理员可以管理项目成员关系。 
• candidates ：只能访问所属项目的数据。 
• interview_rounds ：只能访问所属项目且用户具有对应项目角色的数据。 
• interview_analysis_snapshot ：跟随所属项目、候选人和面试轮次的访问权限。 
• ai_tasks ：只能访问自己有权限查看的项目任务。 
• conversations / conversation_messages ：只能访问对应项目、候选人和面试轮次的
  数据。 
• files ：只能访问其关联项目/候选人的文件。 
管理员操作通过服务端 API 执行，不依赖前端直接修改数据库权限字段。
4.2 认证与鉴权
采用 Supabase Auth。 
用户登录后由 Auth 提供身份信息，后端从认证上下文获取当前用户 ID，不接受前端自行传入的创建
人 ID作为可信身份依据。
权限判断：


 1    Auth   身份
 2    ↓
 3    当前 User ID
 4    ↓
 5    查询 Project ↔ User 关系
 6    ↓
 7    判断 role
 8    ↓
 9    决定是否允许操作

项目创建人可以管理项目成员；普通项目成员不能操作其他成员负责的候选人；管理员具有更高管理
权限。
涉及删除、转移、角色调整等操作时，统一经过后端 API 校验身份和项目角色。
4.3 删除与转移
• 项目创建者可以管理未开始面试的候选人及面试官关系。

 代码块
 1 邀请成员
 2    ↓
 3    输入邮箱
 4    ↓
 5    系统发送邀请通知 + 登录链接
 6    ↓
 7    用户登录/注册
 8    ↓
 9    查看项目邀请
 10   ↓
 11   接受邀请
 12   ↓
 13   写入 Project ↔ User 关系
 14   ↓
 15   获得对应项目角色

• 面试开始后，普通操作不能直接删除已经开始或结束的面试；转移需要被转移人员确认。

 代码块
 1 移除成员
 2    ↓
 3    发送移除确认申请
 4    ↓
 5    被移除成员确认


    6   ↓
    7   执行移除

• 管理员可以执行相应管理操作，但仍保留通知机制。

    代码块
    1 项目创建者/当前负责成员发起转移
    2   ↓
    3   选择承接用户
    4   ↓
    5   发送转移确认申请
    6   ↓
    7   承接用户确认
    8   ↓
    9   转移角色 + 候选人

业务删除采用：
    代码块
    1 前端不可见
    2   +
    3   后台记录保留

4.4 敏感数据
• API Key、LLM Key、Supabase Service Role Key 等全部存放在服务端环境变量。
• 前端不得保存或暴露服务端密钥。 
• IP 等管理数据仅供后台调试和管理使用。 
• 简历、逐字稿等候选人资料通过 Storage 权限控制访问。 
• AI 分析结果、对话内容等业务数据不直接暴露给无权限用户。 


5. API接口协议 (API Specification)
5.1 接口清单


5.2 AI Task API
统一采用：
  代码块
  1 前端
  2   ↓
  3   Vercel API
  4   ↓
  5   创建 ai_task
  6   ↓
  7   返回 task_id + status=pending
  8   ↓
  9   Queue
 10   ↓
 11   Background Worker
 12   ↓
 13   根据 task_type 执行对应 Mastra Workflow
 14   ↓
 15   生成结果
 16   ↓
 17   写入 Database / Snapshot
 18   ↓


 19   Supabase Realtime
 20   ↓
 21   前端更新状态

API 不负责自己执行长任务。API 在创建 Task 时根据 task_type 写入任务信息并进入队列；
Worker 再根据 task_type 选择对应 Mastra Workflow。
 task_type 例如：


  代码块
  1   resume_analysis
  2   verification_question_generation
  3   interview_analysis
  4   round_summary
  5   candidate_summary
  6   verification_question_regeneration


长任务统一进入 Background Worker；不需要为每一种 Workflow 再造一个独立的 Worker API。
5.3 AI Streaming API
AI 对话调整属于实时交互：
  代码块
  1 前端
  2   ↓
  3   Streaming LLM API
  4   ↓
  5   LLM
  6   ↓
  7   Stream
  8   ↓
  9   前端

它和异步 AI Task 分开，因为对话需要即时返回 Token，而面试分析、简历分析等属于后台长任务。
5.4 错误处理
统一使用 HTTP 状态码：


AI Task 失败不会让前端直接看到 Worker 内部的 retry 过程。前端保持 processing ，后台记录
 retryCount/error ；最终无法完成时才变成 failed 。


6. 部署架构 (Deployment)
6.1 环境配置
项目采用 Vercel + Render + Supabase 的混合部署架构。
MVP 采用：
  代码块
  1 本地开发
  2    ↓
  3    Git
  4    ↓
  5    GitHub
  6    ↓
  7    Vercel
  8    ├─ Frontend
  9    └─ API
  10   
  11   Render
  12   ├─ Mastra Web Service
  13   └─ Background Worker
  14   
  15   Supabase
  16   ├─ Auth


 17   ├─ Database
 18   ├─ Storage
 19   ├─ pgvector
 20   └─ Realtime
 21   
 22   Redis / Queue
 23   └─ AI Task Queue


其中：
• Vercel：前端和 API Gateway / Serverless API。 
• Background Worker：持续消费 AI Task Queue，执行长耗时 Mastra Workflow。 
• Mastra Web Service：用于短任务、调试、Mastra Studio、Tracing，不承担主要长耗时面试分析
  任务。 
• Supabase：统一承担认证、数据库、文件存储、向量检索和 Realtime。 
• Queue + Worker 并发数限制为 2，MVP 控制最多两个 AI 长任务同时执行。

6.2 密钥管理

- 密钥全部由服务端环境变量读取，前端不持有任何大模型或数据库的私密密钥。
- 禁止：前端代码写 API Key、GitHub 提交 API Key、配置文件硬编码生产密钥。

6.3 发布流程


  1 本地开发
  代码块
  2   ↓
  3   Git Commit
  4   ↓
  5   GitHub
  6   ↓
  7   Vercel   自动构建部署
  8   +
  9   Render   部署 Worker / Mastra
 10   ↓
 11   检查环境变量
 12   ↓
 13   检查 Build Log
 14   ↓
 15   线上核心流程测试

MVP 阶段只保证开发环境和线上 Demo 环境能够正常跑通，不做复杂的多环境发布体系。
