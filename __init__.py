import asyncio
import glob
import os
from email.utils import formatdate
from urllib.parse import quote

import folder_paths
from aiohttp import web
from server import PromptServer


WEB_DIRECTORY = "./web"
__version__ = "1.1.1"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


def _find_direct_preview(model_path: str, model_root: str) -> str | None:
    dirname = os.path.dirname(model_path)
    if not os.path.isdir(dirname):
        return None

    basename = os.path.splitext(model_path)[0]
    candidates = glob.glob(f"{glob.escape(basename)}.*", recursive=False)
    for filename in folder_paths.filter_files_content_types(candidates, ["image"]):
        stem = os.path.splitext(filename)[0]
        if stem not in (basename, f"{basename}.preview"):
            continue
        if os.path.isfile(filename) and folder_paths.is_within_directory(model_root, filename):
            return filename
    return None


def _encoded_filename(filename: str) -> str:
    return quote(filename.replace("\\", "/"), safe="/")


@PromptServer.instance.routes.get(
    "/vue_model_preview/preview/{folder}/{path_index}/{filename:.*}"
)
async def get_direct_model_preview(request):
    folder_name = request.match_info.get("folder")
    filename = request.match_info.get("filename")
    if not folder_name or not filename:
        return web.Response(status=400)
    if folder_name not in folder_paths.folder_names_and_paths:
        return web.Response(status=404)

    try:
        path_index = int(request.match_info.get("path_index"))
    except (TypeError, ValueError):
        return web.Response(status=400)

    folders = folder_paths.folder_names_and_paths[folder_name][0]
    if path_index < 0 or path_index >= len(folders):
        return web.Response(status=404)

    model_root = folders[path_index]
    model_path = os.path.normpath(os.path.join(model_root, filename))
    if not folder_paths.is_within_directory(model_root, model_path):
        return web.Response(status=403)

    preview_path = await asyncio.to_thread(
        _find_direct_preview, model_path, model_root
    )
    if preview_path is None:
        fallback = (
            f"/api/experiment/models/preview/{quote(folder_name, safe='')}/"
            f"{path_index}/{_encoded_filename(filename)}"
        )
        return web.Response(status=307, headers={"Location": fallback})

    stat = await asyncio.to_thread(os.stat, preview_path)
    etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
    headers = {
        "Cache-Control": "private, max-age=300",
        "ETag": etag,
        "Last-Modified": formatdate(stat.st_mtime, usegmt=True),
    }
    if request.headers.get("If-None-Match") == etag:
        return web.Response(status=304, headers=headers)
    return web.FileResponse(preview_path, headers=headers)


__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "__version__",
]
