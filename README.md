# DeepSeek Harness Desktop

DeepSeek Harness 的桌面客户端 —— **不用打开浏览器**，双击即用。它会自动做这些事：

1. 探测 `http://127.0.0.1:3080` 上是否已有运行中的 DeepSeek Harness 服务：有 → **直接连接**；没有 → **自动拉起** `dsh web` 服务（启动进度和日志实时显示在启动画面上）；
2. 服务就绪后进入**应用外壳**：顶部横栏 + 「仪表盘 / 工作台」双视图；
3. 退出应用时默认**自动关闭**由它拉起的服务（设置中可关闭「退出确认弹窗」或选择保留服务）。

## 应用界面

> 视觉设计：军绿（`#4c583c`）+ 灰白（`#f4f5f0`）的极简浅色主题，黑色 DeepSeek 鲸鱼 logo；顶栏与仪表盘为**扁平无边框、无圆角**，靠留白与字体粗细/颜色分层，全界面无渐变色。

### 顶部横栏

- 左侧：黑色 DeepSeek 鲸鱼 logo + 应用名，以及「**仪表盘** / **工作台**」切换标签（快捷键 `Ctrl+1` / `Ctrl+2`，菜单「视图」中也有入口；当前页以军绿色加粗字标出，无边框无底纹）；
- 右侧：**设置图标**（⚙）→ 打开应用设置窗口。

### 仪表盘

扁平无卡片布局，自上而下：

- **欢迎区**（约占 1/4 屏）：按时段问候（早上好 / 下午好 / 晚上好…）+ 日期星期，右侧随「星期几 + 小时」每小时轮换一首小古诗（内置 40 首经典绝句）；
- **本月概览**：本月 Token 消耗、预估花费、请求数、会话数、日均花费；
- **用量明细**：今日 / 近 7 天 / 本月 / 累计四个维度的请求、输入、输出、缓存读、花费；
- **账户余额**：实时余额、充值 / 赠送、状态、更新时间、计费单价（官方余额接口）；
- **每日消耗图表**：本月逐日柱状图，金额 / Tokens 双维度切换，悬停看当天明细；
- **页脚**：当前应用版本号 + 数据来源说明。
- 数据口径：用量来自本机 Harness 会话日志（`~/.dsh/sessions`）按天聚合；金额按计费单价估算（单价可在设置中修改，默认取 DeepSeek 官方公开价）。

### 工作台

- 内嵌完整 DeepSeek Harness 界面（iframe 加载本地服务）；
- **余额与用量浮窗只在工作台显示**：右下角胶囊（余额 + 今日请求数）→ 点击展开详情面板（余额明细、今日 / 近 7 天用量、7 天日均对比条、快捷刷新 / 设置 / 隐藏 / 平台用量页入口）；
- 服务中断时工作台显示覆盖层，可一键重试或改用浏览器打开；仪表盘数据不受影响（本地统计）。

### 设置（顶栏右侧 ⚙）

- 余额查询：API Key 覆盖（默认读取 `~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY`）、余额接口地址（兼容 new-api/one-api 风格中转）、自动刷新间隔；
- 计费单价：输入 / 输出 / 缓存读 / 缓存写（每百万 tokens，元），用于估算每日金额；
- 退出行为：关闭窗口时弹出退出确认、退出时保留本地服务；
- 浮窗开关：在工作台显示余额与用量浮窗。

> API Key 只保存在本机桌面客户端配置（`%APPDATA%\DeepSeekHarnessDesktop\settings.json`），仅用于向余额接口发送查询请求。

## 快速开始

前置条件：本机已安装 Node.js（≥ 18）和 DeepSeek Harness CLI：

```bash
npm install -g @deepseek-ai/dsh
```

首次运行（安装 Electron 依赖）：

```bash
npm install
```

之后任选其一启动：

- 双击 `启动DeepSeekHarness.cmd`
- 或在命令行执行 `npm start`

## 命令行参数

```bash
npm start -- --port 3090        # 使用其他端口（默认 3080）
npm start -- --no-server        # 只连接、不拉起服务
npm start -- --dsh-cli D:\dsh\dsh.cmd   # 指定 dsh 命令路径
npm run smoke                   # 冒烟测试：连上即打印 SMOKE-OK 并退出
```

等价环境变量：`DSH_PORT`、`DSH_HOST`、`DSH_CLI`。

## 打包成 exe

```bash
npm run dist
```

产物输出在 `dist/`：

- `DeepSeek Harness Desktop Setup <版本>.exe` —— 安装版（可选安装目录、创建桌面/开始菜单快捷方式）
- `DeepSeek Harness Desktop <版本>.exe` —— 便携版（免安装，双击即用）

> 说明：打包后的 exe 仍需要本机装有 Node.js 与 `dsh` CLI —— 因为 DeepSeek Harness 服务端本身是 Node 应用，桌面客户端负责把它“装进窗口”并管理其生命周期。

## 常见问题

- **端口被其他程序占用**：启动画面会提示错误，改个端口点「重试」即可（端口会被记住）。
- **提示找不到 dsh**：执行 `npm install -g @deepseek-ai/dsh` 后点「重试」。
- **服务日志**：保存在 `%APPDATA%\DeepSeekHarnessDesktop\logs\server.log`，启动画面「查看服务日志」或菜单「帮助 → 打开服务日志」可直接打开。
- **余额查询失败**：检查网络与 Key（`~/.dsh/.credentials.yaml` 中的 `DEEPSEEK_API_KEY`，或到设置窗口手动覆盖）；如使用中转/代理服务，可在设置里自定义余额接口地址。
- **用量与金额口径**：用量来自本机 Harness 会话日志（今日 / 近 7 天 / 本月），金额按设置单价估算，与官方平台的账单口径可能有差异，以 [平台用量页](https://platform.deepseek.com/usage) 为准。

## 项目结构

```
├── package.json            # 项目与 electron-builder 打包配置
├── .npmrc                  # npm / Electron 二进制镜像（npmmirror）
├── src/
│   ├── main.js             # 主进程：服务探测、拉起、生命周期、外壳/设置/菜单
│   ├── usage.js            # 余额查询 + 本地用量聚合（zstd 帧扫描、按天/月统计、计费估算）
│   ├── preload.js          # 安全桥接（contextIsolation + sandbox）
│   ├── splash.html         # 启动画面（进度、日志、端口重试）
│   ├── shell.html          # 应用外壳：顶栏 + 仪表盘 + 工作台 + 余额浮窗
│   └── settings.html       # 设置窗口（余额/单价/退出行为）
├── build/                  # 应用图标（icon.png / icon.ico）
└── 启动DeepSeekHarness.cmd  # 一键启动脚本
```

## 安全说明

客户端只连接回环地址（默认 `127.0.0.1`），与浏览器访问本地服务等价，不向外网开放任何端口。余额查询仅向余额接口发送 API Key 的 Bearer 请求。外部链接一律交给系统默认浏览器打开，渲染进程启用 `contextIsolation` + `sandbox`，不注入任何 Node 能力。
