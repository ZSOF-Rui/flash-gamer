# Flash Gamer v0.4.0

- 新增 Windows 32 位、Windows 64 位、macOS Intel 与 macOS Apple 芯片四个平台构建，源码和 GitHub Actions 构建流程一并公开。
- Electron 固定在 43.x：官方从 44 起不再提供 Windows 32 位二进制，43.x 是仍覆盖四个目标平台的最后分支。
- 新增自定义 SWF 下载目录：主界面点「下载目录」即可选择保存位置，可把现有游戏库复制到新目录，重启后生效。
- 更新器按平台与架构读取对应清单；macOS 使用 DMG / ZIP 更新包。
- 官网改为四平台下载，并提供各安装包的 SHA-256 校验值。
- 许可证改为 CC BY-NC 4.0，仅限非商业使用；Electron、Ruffle 等第三方组件仍遵循各自许可证。
- 安装包没有代码签名：Windows SmartScreen 与 macOS Gatekeeper 可能提示未知发布者，请核对 SHA-256 后手动放行。
