# 使用范围与第三方许可声明

## 一、使用范围（Intended Use）

本包（`@waiyubaodian/hevc-player`）为**个人学习与研究用途**开发，供「外语考证宝典」项目本地集成使用，**不用于商业产品发布**。

> ⚠️ **重要说明**：以上表述是作者的**使用意图声明**，**不构成法律意义上的使用限制**，也不改变本包 LICENSE（MIT）授予任何获取者的权利。若需在法律上限制用途，须另行更换许可证——但由于本包内含 LGPL-3.0 组件，**对其附加"非商用"等额外限制将违反 LGPL-3.0**，故本包不提供此类限制性许可。

## 二、风险提示（与本声明无关，客观存在）

以下风险**不因"非商用"声明而消除**：

1. **H.265/HEVC 标准必要专利**
   专利许可按使用行为/产品数量授权，不存在通用的"非商用豁免"。个人学习、少量内部使用在实践中被追究的概率极低，但法律上仍属未获专利许可的实施行为。

2. **LGPL-3.0 分发义务**
   一旦对外分发（包括发布到公开 npm、交付给第三方），需履行 LGPL-3.0 义务：提供对应源码、允许替换该库。该义务**与是否商用无关，只与是否分发有关**。

3. **MIT 许可不可撤销**
   任何获得本包副本的人，均可依 MIT 条款将其用于商业用途。

**结论**：若要最大限度降低风险，最有效的方式是**不进行公开分发**（仅在本地以 `file:` 方式引用）。

## 三、第三方组件与源码获取

本包在构建产物中内联了以下第三方组件：

### 1. libde265 — LGPL-3.0-only

| 项 | 内容 |
|---|---|
| npm 包 | `@yume-chan/libde265@^1.0.0` |
| 上游项目 | https://github.com/strukturag/libde265 |
| WASM 封装 | https://github.com/Yume-chan/libde265.js |
| 许可证全文 | https://www.gnu.org/licenses/lgpl-3.0.txt |
| **源码获取** | 见下方「源码获取方式」 |

**分发形态说明**：本包通过 Vite 将 libde265 的 WebAssembly 模块（约 360KB）内联进 `dist/hevc-player.js` / `dist/hevc-player.cjs` 及内联 Worker 中，属于**与 LGPL 库结合分发**的情形。

**源码获取方式**（履行 LGPL-3.0 §4 / §6 义务）：

```bash
# 方式一：从 npm 获取该依赖的完整源码
npm pack @yume-chan/libde265
# 或直接下载：
# https://registry.npmjs.org/@yume-chan/libde265/-/libde265-1.0.0.tgz

# 方式二：从上游获取
git clone https://github.com/Yume-chan/libde265.js
```

如需替换/重新链接该解码库，请参考 `ARCHITECTURE-AND-GUIDE.md` 第 9.2 节「换/加解码后端」，`DecodeBackend` 已预留扩展位。

### 2. mp4box — BSD-3-Clause

| 项 | 内容 |
|---|---|
| npm 包 | `mp4box@^2.5.0` |
| 上游项目 | https://github.com/gpac/mp4box.js |
| 许可证 | BSD-3-Clause（宽松许可，无源码分发强制义务） |

## 四、测试素材来源

`examples/basic/public/` 与 `test/fixtures/` 下的 H.265 测试流来自开源项目
[h265web.js](https://github.com/numberwolf/h265web.js)，**仅用于本地解码验证**，请勿再分发或用于其他用途。
`test-audio.wav` 为脚本合成音源，无版权问题。

---

最后更新：2026-11-21
