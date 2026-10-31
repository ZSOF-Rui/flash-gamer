# Flash Gamer

Flash 小游戏离线馆。把 4399 / 7k7k 的 Flash 游戏页面粘贴进来，取出游戏本体 SWF，存到本地，之后断网也能玩。

只运行游戏文件，不加载网页广告；不安装 Adobe Flash Player，也不带任何捆绑软件。

## 版本

| 版本 | 分支 | 内容 |
| --- | --- | --- |
| v0.1 | 归档于 `release/AppProfessor*` | App Professor 初始版，原样保留 |
| v0.2 | `release/FlashGamer-0.2.0*` | 改名、新图标、独立游戏窗口、后台运行（历史版本） |
| v0.3.0 | `main` | 无浏览器版；修复 4399 加壳游戏（抽出内嵌 SWF 顶播） |
| v0.3.1-dev | `dev` | 在 v0.3.0 基础上加网页浏览与在线登录 |

## 用法

1. 打开 Flash Gamer。
2. 把游戏页链接（例如 `https://www.4399.com/flash/10802_1.htm`）粘贴到顶部输入框，点「解析」。
3. 解析完成后游戏自动入库并开始播放；如果页面里有多个 SWF，会弹出候选列表，第一个通常就是游戏本体。
4. 之后在左侧游戏库中随时点开即可。文件保存在本机，断网也能运行。

也可以点「导入 SWF」或直接把 `.swf` 文件拖进窗口。

「独立窗口」会把当前游戏开在单独的窗口里，主窗口继续浏览、解析别的游戏都不会打断它；游戏窗口使用独立的渲染进程且关闭后台限速。

## 广告与捆绑

- 播放器只加载 SWF 本体，不打开游戏网页，页面上的弹窗、悬浮广告、统计脚本都不会执行。
- 抓取阶段会拦截广告与统计域名（`stat.api.4399.com`、`stat.7k7k.com`、MochiAds 等），但放行游戏前置加载器必需的 4399 控制器 SWF 与版本 XML。
- 4399 的 `cell.swf` 广告占位壳会被识别并跳过；被声明为 SWF、实际是 HTML 包装页的地址会自动跟进去取真正的 SWF。
- 部分 4399 游戏外面套了一层加载壳，真正的游戏以 `DefineBinaryData` 内嵌，并被壳用 `Loader` 载入。内层游戏会检测“是否被加壳运行”，命中就拒绝启动；本程序会把内嵌游戏抽出来（`items/<id>/play.swf`）作为顶层影片播放，壳的反加壳检查因此不成立。
- 同一个 SWF 按 SHA-256 去重，重复解析或重复导入不会产生两份文件。
- 安装包只包含 Electron、Ruffle 和本程序，没有捆绑安装器、没有浏览器主页修改、没有遥测上报。

## 技术栈

- [Electron](https://www.electronjs.org/)：桌面壳与网络抓取。
- [Ruffle](https://ruffle.rs/)：Rust 编写的开源 Flash 模拟器，运行在 WebAssembly 上，不依赖 Adobe Flash Player（使用 0.8.0 nightly 构建）。
- 本地 HTTP 服务（`localhost:43199`）：提供播放器页面、SWF 镜像与资源缓存。页面统一走 `localhost`，4399 壳才会跳过远程服务连接。

Ruffle 的兼容性覆盖大多数 Flash 8 / AS2 游戏；依赖冷门 AS3 特性的内容仍可能无法运行。

## 开发

```bash
npm install
npm start
```

`npm install` 会把 Ruffle 的 web 构建复制到 `vendor/ruffle`（也可以手动执行 `npm run vendor`）。

## 打包

```bash
npm run dist
```

标准情况下 electron-builder 会生成单文件便携版 exe。

如果 Windows 上出现 `EPERM/EBUSY ... default_app.asar`（解压 Electron 后改名被 Defender/索引服务短暂占用），改用已解压 Electron 目录，让它走复制而不是改名：

```bash
ELECTRON_ZIP=$(ls "$LOCALAPPDATA"/electron/Cache/*/electron-v45.1.0-win32-x64.zip | head -1)
"$LOCALAPPDATA/electron-builder/Cache/7zip@1.0.0/7zip-win-x64-1nrf7/bin/7za.exe" x -y "$ELECTRON_ZIP" -o release/electron-dist-45.1.0

npx electron-builder --dir --win --x64 \
  --config.directories.output=release/build-0.3.0-dir \
  --config.electronDist=release/electron-dist-45.1.0
```

`--dir` 产出 `win-unpacked/` 绿色目录，再重命名并压缩即可。完整命令与两个版本的实测记录见 [`docs/FlashGamer-实现复现.md`](docs/FlashGamer-实现复现.md)。

本仓库同时提供已经组装好并实测过的绿色版：

- `release/FlashGamer-0.3.0/`：v0.3.0 解压即用目录（无浏览器），双击 `Flash Gamer.exe` 运行。
- `release/FlashGamer-0.3.0-portable.zip`：v0.3.0 压缩包。
- `release/FlashGamer-0.3.1-dev/`：v0.3.1-dev 解压即用目录（带网页浏览）。
- `release/FlashGamer-0.3.1-dev-portable.zip`：v0.3.1-dev 压缩包。
- `release/AppProfessor/`、`release/AppProfessor-0.1.0-portable.zip`：v0.1，原样保留。
- `release/FlashGamer-0.2.0*`、`release/FlashGamer-0.3.0-dev*`：历史版本，未覆盖。

## 数据位置

- 开发模式：`data/`
- 便携版：exe 同目录的 `FlashGamerData/`（首次运行会自动从旧的 `AppProfessorData/` 迁移游戏库）

删除该目录即可清空游戏库与缓存。
