# ComfyUI Model Preview

ComfyUI 模型下拉框缩略图预览插件，版本 `1.0.0`。
<img width="630" height="480" alt="QQ20261023-222431-HD" src="https://github.com/user-attachments/assets/0a3de771-fb87-43d7-89d8-b7f4a969c607" />
毫秒级加载（用过以前类似的，卡手生涩），你在Windows右键弹出子菜单速度有多快它就有多快（comfyui右键菜单还要手动点击一下才弹出来真是见鬼的设计）
按住分类拖拽排序
记得打开<img width="437" height="151" alt="image" src="https://github.com/user-attachments/assets/f8ddbb96-2ccc-4d6a-9261-0d27049f953b" />


## 功能

- 鼠标悬停模型名称时显示同名缩略图。
- 预览卡片根据屏幕空间显示在列表左侧或右侧。
- 预加载附近模型缩略图，快速移动鼠标时仍能及时显示。
- 按模型所在文件夹分类，支持折叠、搜索和拖拽排序。
- 分类排序按模型类型保存在浏览器 `localStorage`。
- 直接读取模型旁边的图片，并通过 HTTP 缓存减少重复传输。

支持以下模型目录：

| 控件 | 模型目录 |
| --- | --- |
| `ckpt_name`、`checkpoint_name` | `checkpoints` |
| `lora_name` | `loras` |
| `vae_name` | `vae` |
| `control_net_name` | `controlnet` |
| `unet_name` | `diffusion_models` |
| `clip_name`、`text_encoder_name` | `text_encoders` |
| `upscale_model_name` | `upscale_models` |

## 安装

将仓库克隆到 ComfyUI 的 `custom_nodes` 目录：

```powershell
cd E:\ComfyUI_windows_portable\ComfyUI\custom_nodes
git clone https://github.com/LingYingNX/Comfyui-Model-Preview.git
```

重启 ComfyUI，然后刷新浏览器页面。插件没有额外 Python 依赖。

## 缩略图命名

将图片放在模型文件旁边，图片名与模型名相同：

```text
models/
  loras/
    风格/
      model.safetensors
      model.png
```

也支持以下形式：

```text
model.preview.png
```

支持 ComfyUI 识别的常见图片格式，包括 PNG、JPEG 和 WebP。

## 兼容性

插件面向 ComfyUI 新版 Vue 节点界面。安装或更新前端文件后需要刷新浏览器页面；修改 Python 路由后需要重启 ComfyUI。

## 版本

当前版本：`1.0.0`
