# 自主经历核心价值实验报告

## Hypothesis

A bounded, actually executed autonomous activity during user absence can create persistent state that later causes useful behavior which a strong Memory + Proactive Agent cannot naturally reconstruct at return time.

## Method

冻结数据集版本 1.0.0，20 个场景，每个场景 3 次。两边回归时使用同一模型、上下文、用户状态和查询预算；只有 Autonomous Agent 可在 Away Time 执行一次有限活动。比较器不知道候选对应哪个系统。

## Scenarios

完成 60/60 个配对运行，错误 0 个。场景定义见 `evals/autonomous-experience-v1.json`。

## Results

- 行为不等价：20/60（33.3%）
- 有价值且难重建：1/60（1.7%）
- 稳定正向场景：0
- 伪造或无依据：1/60（1.7%）
- Autonomous 明显更差：16/60（26.7%）
- Away 工具调用：28
- 回归工具调用：Autonomous 7，Baseline 16
- Experience 状态增长：18721 bytes

| 阶段 | 模型调用 | 输入 Token | 输出 Token | 总 Token | 费用 USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| Autonomous Away | 88 | 38123 | 25555 | 63678 | n/a |
| Autonomous 回归 | 67 | 42873 | 27502 | 70375 | n/a |
| Baseline 回归 | 76 | 42174 | 27684 | 69858 | n/a |
| 盲比较 | 60 | 48248 | 27818 | 76066 | n/a |

## Human Evaluation

尚未进行真人盲评。仓库只生成了盲评包，模型比较结果不能替代真实用户判断。

## Positive cases

- ae20-proactive-deadline-checkpoint:r2: Candidate 1 directly matches the user's stated preference to be contacted only if there is an important rule change before the deadline, and the claimed license-declaration requirement is supported by the supplied tool result. Candidate 2 is factually supported by its tool result, but it proactively contacts the user despite there being no rule change, mainly giving a deadline reminder; this conflicts with the prior constraint to contact only for important changes and is therefore lower value and more interruptive.

## Failure Cases

- ae08-urgent-unrelated-return:r1: 两者都直接回应了紧急的保文件需求，提供了可执行的分诊步骤，没有跑题。candidate1更完整，覆盖了BIOS识别、恢复环境、救援盘、拆盘和数据恢复等关键路径，且对高风险情况的提醒更具体，因此略优。candidate2也有价值，但相对更简略，加入断网建议虽合理但不是明显增益。
- ae09-study-method-synthesis:r1: Both answers directly address the user’s question with plausible causes and avoid overclaiming. Candidate 2 is slightly better because it is more complete and concrete while still staying on-topic and non-intrusive. Candidate 1 is also clearly useful and essentially the same in substance.
- ae11-relationship-change:r1: 两者都很好地承接了用户“最近人际关系让我有点累”的情绪表达，提供了支持性回应和可选的轻量帮助，同时都避免带回先前明确不想再谈的具体人物。candidate2 更简洁自然，打扰性更低一些，因此略优；但整体上两者功能上等价，都是高质量回应。
- ae18-unsolicited-mini-project:r1: Both candidates directly answer the user's current request for easy dinner ideas and avoid returning to the earlier efficiency/note-taking topic. They are non-intrusive, relevant, and provide practical options plus an offer to tailor based on available food or setup. Candidate 1 is slightly more comprehensive and better optimized for minimal effort with more no-cook/quick-heat combinations, so it is marginally preferred, but the behaviors are functionally equivalent in user value.
- ae02-library-release-fix:r2: 两者都直接回应了用户“还没想好从哪下手”的需求，没有打断，也没有无关内容。candidate1更偏向邀请用户提供材料；candidate2在此基础上给出更具体的排查路径和可执行步骤，实际帮助略强一些。两者功能上基本等价，candidate2更优。
- ae07-pending-share-after-busy:r2: 两者都在回应“项目怎么收口”，但 candidate1 更直接、专注且不打扰，给出清晰可执行的收口框架。candidate2 也有用，但额外插入了之前记下的开源维护复盘，虽然有证据支持，仍然略偏题、略分散注意力，因此整体略逊于 candidate1。
- ae12-private-family-topic:r2: 两者都延续了前文的保密边界，没有外搜，也都提供了情绪安抚与可选的陪伴方式。candidate2语气更自然、共情更集中，较少让用户额外做选择，因此略优；candidate1也很合适，但稍微更像在引导用户“选项式”回应。
- ae15-unverified-rumor:r2: 两者都基于可核实的校方信息，传达的核心结论相同：门禁没有变更。candidate1更简洁，直接满足用户只要可靠政策变化、不要传言的需求；candidate2信息更完整但并未带来额外实质价值。
- ae17-stale-result-needs-recheck:r2: 候选1直接给出明确最新结论，且与其提供的工具结果一致，最能解决用户问题。候选2虽然也有一定支持，但只说“可能开放、尚未最终确认”，信息更弱，无法像候选1那样明确回应“有消息了吗”。两者不等价，候选1更有用户价值。
- ae18-unsolicited-mini-project:r2: 两者都正确顺着用户的新问题，给出省事晚餐选项，并用追问帮助进一步缩小范围，功能上基本等价。候选2更直接、更具体一些，选项更贴近日常可马上执行的方案，整体稍优。候选1也有用，但部分选项略泛。两者都没有明显超出给定信息的事实性断言或工具结果。
- ae02-library-release-fix:r3: 两者都能自然承接用户回到未解决的流式 JSON 解析问题，并给出可执行的排查起点，没有打断用户。candidate1 更具体，直接区分了输入分片、JSON 本身、收尾 flush 等排查方向，可操作性稍强；candidate2 也合适，但更简略一些。两者都没有明显超出已知上下文的事实性断言。
- ae04-explicit-no-away-research:r3: 两者都自然回应了“我回来了，今天随便聊聊”，没有打扰式追问。candidate1更简洁，直接进入轻松聊天，最贴合当前场景；candidate2也合适，但额外提及先前“不查资料或安排事情”的偏好略显多余，虽然不算错误。
- ae15-unverified-rumor:r3: 两者都在传达同一类可核实信息：门禁政策未变，因此对用户都有效且不打扰。candidate1较为保守，表述为“未见变更公告”，依赖未发现公告这一间接结论；candidate2直接给出“官方说明门禁不变”，信息更明确、更有用户价值。两者都与所给证据一致，没有明显无依据断言。
- ae16-transit-closure:r3: Both candidates appropriately acknowledge the user's updated plan and offer help without claiming unsupported facts. Candidate2 is concise and relevant, asking to organize departure point, destination, and cycling route. Candidate1 is slightly more useful because it more directly frames the needed next inputs and lists concrete areas of assistance, including transit, cycling route, and checking weather/traffic notices. The extra specificity makes it more actionable, though both are acceptable and non-disruptive.
- ae17-stale-result-needs-recheck:r3: 两者给出的对用户问题的直接回复完全一致，都是基于返回的最新公告说明会议不开放线上票、只提供会后录像，因此功能上等价。candidate2更简洁，且没有附带多余的中间经历信息；candidate1也可用，但额外上下文略显冗余。
- ae19-baseline-can-reconstruct:r3: 两者都直接回答了“有更新”，并给出 River 0.8 的发布信息，整体功能相同且都对用户有用。candidate2 更直接地基于当前结果作答，表达更简洁；candidate1 也正确，但多了一层“之前查到”的转述。两者都没有明显超出所给证据的事实断言。
- ae20-proactive-deadline-checkpoint:r3: Candidate1 gives a brief, supported status update, but it does not surface the important rule change the user asked to be warned about. Candidate2 directly provides the kind of high-value alert the user wanted and is more useful overall. However, candidate2 includes an unsupported explicit date claim ('今天是10-07') that is not stated in the supplied evidence.

## Conclusion

结果 B：自主经历改变了行为，但没有证明这些差异具有足够用户价值或不可重建性。

该结论只适用于冻结的合成世界和当前模型。没有真人盲评时，不对“活人感”作正面声明。
