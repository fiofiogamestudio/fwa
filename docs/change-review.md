# 从候选到采用与撤销

普通打开工作台始终进入“需求”，已有目标也不改变默认入口；对象深链仍直接打开对应详情。填写需求后选择“生成修改计划”，默认不会开始执行。参考文件和权限设置从“添加参考资料”展开；需要规划后直接执行时，在“执行设置”明确选择该模式。提交后的最近请求会展开，显示问题、失败或已产生的计划。

主导航为“需求 / 修改 / 进度”。在进度页查看计划和任务状态，并按原权限启动就绪任务；任务 DAG、引用、执行历史、证据、事件、项目与手工计划入口保留在“高级”。切换至修改页可按行为标题选择某项修改，“全部修改”保留完整列表。

需求页不显示目标筛选、重复标题或空历史；输入后直接生成计划。进度页显示实际任务和待处理状态，去掉统计卡片。未配置规划器或项目检查时保留明确提示；验证失败直接显示在修改详情，不必展开操作记录。成功状态使用短标签，验收规则和技术信息按需查看。

修改详情先展示文件差异和证据，再显示当前阶段的操作：“验证这项修改”“记录人工验收”或“回归通过后采用”。验证设置和版本技术记录按需展开。Work 仍先产出独立工作树中的候选，不自动替用户验收。已采用后才能从“撤销此项”查看依赖影响、填写单独的撤销原因并发起回归；验收结论不会自动复用为撤销原因。

验证调用现有 CommandEvaluator，在确切候选提交的独立工作树执行项目检查。它遵守 Node 的验收合同：配置 ID 或每个检查 ID 必须匹配，不能用一个永远返回成功的脚本冒充功能验证。失败结果保留为 Evidence，主工作区不动。核心的 `accepted` 表示客观检查通过；工作台的人工验收另存不可变作业结果，绑定候选 SHA、Evidence ID、启动配置摘要和用户结论。采用必须同时具备这两者。

采用与撤销都使用现有 regression-gated 流程：在独立工作树准备候选，运行同时包含 compile 和 test 的回归配置，通过后才移动指定目标。撤销追加反向提交，保留后续无关修改；详情先展示已声明的依赖影响，可能失效的现有结果明确标注。Git 冲突或回归失败不会移动目标。声明依赖不是对代码语义的完整证明。

## 接通已有项目检查

如果项目已有 FWA 验收和回归 profile，可直接组合；无需在页面输入命令：

```powershell
node tools/create-review-config.mjs --validation D:/Game/acceptance.json --regression D:/Game/regression.json --target main --output D:/Game/review.json
start.bat --project D:/Game --allow-write --review-config D:/Game/review.json --check
start.bat --project D:/Game --allow-write --review-config D:/Game/review.json
```

辅助脚本拒绝覆盖已有文件，先校验配置但不运行检查。`--check` 展示目标分支与验收检查 ID。同一入口也适用于 `fwa editor --review-config ...`。配置是启动时受信的工具配置，页面请求只选择已配置的 profile ID，不能提交 executable、shell、profile 对象或服务端路径。

配置格式：

```json
{
  "schemaVersion": 1,
  "targetRef": "main",
  "validationProfiles": [
    {
      "schemaVersion": 1,
      "id": "counter-acceptance",
      "checks": [
        { "id": "counter-increments", "kind": "test", "command": "node", "args": ["--test", "counter.acceptance.test.mjs"], "timeoutMs": 30000 }
      ]
    }
  ],
  "regressionProfile": {
    "schemaVersion": 1,
    "id": "counter-regression",
    "checks": [
      { "id": "compile", "kind": "compile", "command": "node", "args": ["--check", "counter.mjs"], "timeoutMs": 30000 },
      { "id": "tests", "kind": "test", "command": "node", "args": ["--test", "counter.test.mjs"], "timeoutMs": 30000 }
    ]
  }
}
```

示例里的文件必须是项目真实检查，不能原样放到不含这些文件的工程。对应 Node 的 `acceptance.checks` 为 `["counter-increments"]`。多个合同可加入 `validationProfiles`，页面只展示与当前 Node 完整匹配的配置。配置后的 Planner 会收到受信检查目录，要求选择适用的完整合同，并在叶子中说明必要的功能测试；未覆盖的需求应返回问题。控制器会拒绝输出无法匹配检查的计划。旧计划的自然语言验收描述若尚无真实检查，页面会列出所需条件并停止验证；应编写可运行检查或修订合同，不能把描述随意映射成通用编译通过。

## 记录与恢复

每次操作都使用持久 command ID。请求超时后重试同一意图会复用原作业，已经执行的集成或撤销不会重复。页面刷新后可继续查看作业与验收记录；候选、Evidence 或工程事件发生变化时旧审查 token 被拒绝，必须刷新查看新事实。验收结论草稿跨工作台刷新保留，页面重载后不保留未提交草稿。

人工验收记录在 `.fwa/workbench-jobs`，核心 Git/Run/Evidence 记录在既有事件库；不是对外发布。已过期或已被新版本替代的候选不能被人工验收绕过。安全 fence、未知进程存活、崩溃后的恢复仍需通过既有 CLI 检查并明确处理。

本流程不会凭检查退出码自动宣称游戏视觉验收通过；截图、录像与运行验收仍应由真实项目检查产生并绑定确切版本。任何回归失败都显示为未通过，即使异步协调作业本身成功返回。

## 同一基线的有 / 无对照

在启动配置中加入可选的 `experiment` 后，从已采用修改的“对比效果：保留 / 排除此项”展开并生成对照。结果使用详情的完整宽度，图片和检查结果优先显示，SHA、工作树路径、完整日志和固定条件可再展开。辅助脚本生成配置后，可按实际项目添加这一段：

```json
{
  "experiment": {
    "conditions": { "scene": "counter-arena", "seed": 42, "camera": "review-camera", "input": "counter-recording-01" },
    "profile": {
      "schemaVersion": 1,
      "id": "counter-comparison",
      "checks": [
        {
          "id": "capture-counter-scene",
          "kind": "test",
          "command": "node",
          "args": ["tools/capture-counter-scene.mjs"],
          "timeoutMs": 60000,
          "expectedArtifacts": [{ "path": "captures/counter.png" }]
        }
      ]
    }
  }
}
```

这段是加入完整 review 配置的字段，不是独立启动配置。`profile` 遵循 CommandEvaluator 的格式，所有命令仍由受信启动配置提供，页面只能发起已配置的实验。每侧最多 8 个检查；检查必须实际运行并产生本次截图，不能复用仓库里已存在且未改变的图片冒充新结果。`conditions` 是非空的命名标量对象，值只能是字符串、有限数字或布尔值。项目运行器从 `FWA_EXPERIMENT_CONDITIONS` 读取其 JSON，自行固定场景、随机种子、相机、输入与必要的重置过程；上述脚本与素材应当真实存在于两个版本中。

A 从目标分支当前已采用版本创建隔离工作树；B 从完全相同的基线出发，只反向撤销所选变化的 `integratedRevision`。后续独立变化仍保留，目标分支不移动。目标在准备期间改变时会拒绝旧请求；排除产生 Git 冲突时不会运行对照。若已有采用的后续变化通过声明依赖、逻辑引用或文件读取依赖这一项，页面列出阻挡项并拒绝把多项联动变化称为单变量实验。

两栏展示各自 SHA、相同条件和 profile、每个检查的输出、绑定到本次运行的截图及两个版本的代码差异。PNG、JPEG、WebP 预览有大小限制；大文件和其他产物仍留在对应实验工作树。两侧检查都成功只表示实验已就绪，真实控制变量是否成立取决于项目运行器的设置，视觉效果与玩法结论仍需人工判读。计数器示例证明工作流，不代表任何真实游戏或模型已验收。

实验工作树、引用和 `.fwa/workbench-jobs` 中的历史结果会保留，刷新页面可重新查看；本版本没有自动清理实验或将实验版本采用的按钮。相关真实 Git 测试见 `test/change-experiments.test.js`，真实浏览器的隔离计数器闭环可运行 `tools/check-change-review-browser.mjs --fwe <FWE路径> --browser <Chrome路径> --playwright <playwright/index.mjs路径> --output <报告目录>`。
