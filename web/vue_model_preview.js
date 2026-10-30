import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const FOLDER_PATTERNS = [
  [/^(?:ckpt|checkpoint)(?:_?\d+)?(?:_?(?:name|model_name)(?:_?\d+)?)?$/, "checkpoints"],
  [/^lora(?:_?\d+)?(?:_?(?:name|model_name)(?:_?\d+)?)?$/, "loras"],
  [/^vae(?:_?\d+)?(?:_?(?:name|model_name)(?:_?\d+)?)?$/, "vae"],
  [/^control_net(?:_?\d+)?(?:_?(?:name|model_name)(?:_?\d+)?)?$/, "controlnet"],
  [
    /^(?:unet|diffusion_model)(?:_?\d+)?(?:_?(?:name|model_name)(?:_?\d+)?)?$/,
    "diffusion_models",
  ],
  [
    /^(?:clip|text_encoder)(?:_?\d+)?(?:_?(?:name|model_name)(?:_?\d+)?)?$/,
    "text_encoders",
  ],
  [/^upscale_model(?:_?\d+)?(?:_?(?:name|model_name)(?:_?\d+)?)?$/, "upscale_models"],
];

const NODE_WIDGET_FOLDERS = new Map([
  ["easy diffusionModelLoader", { model_name: "diffusion_models" }],
]);

const HOVER_DELAY_MS = 16;
const HIDE_DELAY_MS = 80;
const CARD_GAP_PX = 8;
const PREFETCH_COUNT = 8;
const PREFETCH_RADIUS = 2;
const UNCATEGORIZED = "未分类";
const CATEGORY_STORAGE_PREFIX = "cvmp.categoryOrder.v1";
const EXPANDED_STORAGE_PREFIX = "cvmp.expandedCategories.v1";
const LEGACY_MENU_MARGIN = 8;
const LEGACY_REOPEN_GUARD_MS = 250;

let hoverTimer;
let hideTimer;
let animationFrame;
let scanFrame;
let hoverToken = 0;
let activeOption = null;
let activeListbox = null;
let card;
let image;
let caption;

const folderModels = new Map();
const resolvedModels = new Map();
const previews = new Map();
const listboxFolders = new WeakMap();
const prefetchedListboxes = new WeakSet();
const categoryContexts = new WeakMap();
const patchedLegacyWidgets = new WeakSet();
const categoryCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
let draggedCategory = null;
let legacyMenu;
let legacyClosedWidget;
let legacyClosedAt = 0;

function widgetFolder(widgetName, node) {
  const normalized = widgetName.toLowerCase().replace(/[\s-]+/g, "_");
  const nodeClass = node?.comfyClass ?? node?.type;
  const nodeFolder = NODE_WIDGET_FOLDERS.get(nodeClass)?.[normalized];
  if (nodeFolder) return nodeFolder;
  return FOLDER_PATTERNS.find(([pattern]) => pattern.test(normalized))?.[1] ?? null;
}

function normalizedModelName(name) {
  return name.replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase();
}

function loadFolderModels(folder) {
  if (!folderModels.has(folder)) {
    const promise = api
      .fetchApi(`/experiment/models/${encodeURIComponent(folder)}`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .catch(() => []);
    folderModels.set(folder, promise);
  }
  return folderModels.get(folder);
}

function resolveModel(folder, name) {
  const key = `${folder}\0${normalizedModelName(name)}`;
  if (!resolvedModels.has(key)) {
    const promise = loadFolderModels(folder).then((models) => {
      const wanted = normalizedModelName(name);
      return models.find((model) => normalizedModelName(model.name) === wanted) ?? null;
    });
    resolvedModels.set(key, promise);
  }
  return resolvedModels.get(key);
}

function decodePreviewUrl(url) {
  return new Promise((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = async () => {
      await image.decode().catch(() => {});
      resolve(url);
    };
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

function loadPreview(url) {
  if (!previews.has(url)) {
    const promise = decodePreviewUrl(url).then((loaded) => (loaded ? url : null));
    previews.set(url, promise);
  }
  return previews.get(url);
}

function previewUrl(folder, model) {
  const encodedName = model.name
    .split(/[\\/]/)
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return api.apiURL(
    `/vue_model_preview/preview/${encodeURIComponent(folder)}/${model.pathIndex}/${encodedName}`,
  );
}

function getOptions(listbox) {
  return [...listbox.querySelectorAll('[role="option"]')].filter(
    (option) => !option.closest(".cvmp-tree"),
  );
}

function optionName(option) {
  return option.getAttribute("textvalue") ?? option.textContent?.trim() ?? "";
}

function getWidgetForListbox(listbox) {
  const trigger = getTrigger(listbox);
  return trigger ? getWidget(trigger) : null;
}

function widgetModelNames(widget, node) {
  let values = widget?.options?.values;
  if (typeof values === "function") values = values(widget, node);
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}

function getModelNames(listbox) {
  const trigger = getTrigger(listbox);
  const widget = trigger ? getWidget(trigger) : null;
  const node = trigger ? getTriggerNode(trigger) : null;
  const names = widgetModelNames(widget, node);
  if (!names.length) return getOptions(listbox).map(optionName).filter(Boolean);
  return [...new Set(names)];
}

function selectedModelName(listbox, widget, options) {
  const selectedOption = options.find(
    (option) => option.getAttribute("aria-selected") === "true",
  );
  if (selectedOption) return optionName(selectedOption);
  return typeof widget?.value === "string" ? widget.value : null;
}

function getListboxFolder(listbox) {
  if (listboxFolders.has(listbox)) return listboxFolders.get(listbox);

  const widget = getWidgetForListbox(listbox);
  const trigger = widget ? getTrigger(listbox) : null;
  const node = trigger ? getTriggerNode(trigger) : null;
  const folder = widget?.name ? widgetFolder(widget.name, node) : null;
  if (folder) listboxFolders.set(listbox, folder);
  return folder;
}

function splitModelName(name) {
  const normalized = name.replaceAll("\\", "/");
  const separator = normalized.lastIndexOf("/");
  if (separator < 0) {
    return { category: UNCATEGORIZED, filename: normalized };
  }
  return {
    category: normalized.slice(0, separator),
    filename: normalized.slice(separator + 1),
  };
}

function categoryStorageKey(folder) {
  return `${CATEGORY_STORAGE_PREFIX}.${folder}`;
}

function loadCategoryOrder(folder) {
  try {
    const value = JSON.parse(localStorage.getItem(categoryStorageKey(folder)));
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function saveCategoryOrder(folder, order) {
  try {
    localStorage.setItem(categoryStorageKey(folder), JSON.stringify(order));
  } catch {
    // Storage can be unavailable in private or embedded browser contexts.
  }
}

function expandedStorageKey(folder) {
  return `${EXPANDED_STORAGE_PREFIX}.${folder}`;
}

function loadExpandedCategories(folder) {
  try {
    const raw = localStorage.getItem(expandedStorageKey(folder));
    if (raw === null) return null;
    const value = JSON.parse(raw);
    return new Set(
      Array.isArray(value) ? value.filter((item) => typeof item === "string") : [],
    );
  } catch {
    return null;
  }
}

function saveExpandedCategories(folder, expanded) {
  try {
    localStorage.setItem(expandedStorageKey(folder), JSON.stringify([...expanded]));
  } catch {
    // Storage can be unavailable in private or embedded browser contexts.
  }
}

function orderedCategories(categories, savedOrder) {
  const ranks = new Map(savedOrder.map((category, index) => [category, index]));
  return [...categories].sort((left, right) => {
    const leftRank = ranks.get(left);
    const rightRank = ranks.get(right);
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      return leftRank - rightRank;
    }
    return categoryCollator.compare(left, right);
  });
}

function makeIcon(className) {
  const icon = document.createElement("i");
  icon.className = `${className} cvmp-icon`;
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function findSourceOption(listbox, modelName) {
  return getOptions(listbox).find((option) => optionName(option) === modelName) ?? null;
}

function applyWidgetValue(widget, node, modelName, event) {
  if (!widget || !modelName || widget.value === modelName) return;

  if (typeof widget.setValue === "function") {
    widget.setValue(modelName, { e: event, node, canvas: app.canvas });
  } else {
    const previous = widget.value;
    widget.value = modelName;
    try {
      widget.callback?.call(widget, modelName, app.canvas, node);
      node?.onWidgetChanged?.(widget.name, modelName, previous, widget);
    } finally {
      app.graph?.setDirtyCanvas?.(true, true);
      app.graph?.change?.();
    }
  }

  const tracker = app.extensionManager?.workflow?.activeWorkflow?.changeTracker;
  (tracker?.captureCanvasState ?? tracker?.checkState)?.call(tracker);
}

function selectModel(listbox, modelName) {
  if (!modelName) return;

  const option = findSourceOption(listbox, modelName);
  if (option) {
    option.click();
    return;
  }

  const trigger = getTrigger(listbox);
  const widget = trigger ? getWidget(trigger) : null;
  const node = trigger ? getTriggerNode(trigger) : null;
  if (!widget) return;

  try {
    applyWidgetValue(widget, node, modelName);
  } finally {
    listbox
      .querySelector('[data-testid="widget-select-default-search-input"]')
      ?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    hideCard();
  }
}

function createLegacyMenu() {
  const menu = document.createElement("div");
  menu.className = "cvmp-legacy-menu";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "选择模型");
  menu.setAttribute("aria-hidden", "true");

  const search = document.createElement("label");
  search.className = "cvmp-legacy-search";
  search.append(makeIcon("icon-[lucide--search]"));

  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "搜索模型";
  input.setAttribute("aria-label", "搜索模型");
  search.append(input);

  const list = document.createElement("div");
  list.className = "cvmp-legacy-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "模型列表");

  const empty = document.createElement("div");
  empty.className = "cvmp-legacy-empty";
  empty.textContent = "没有匹配的模型";
  empty.hidden = true;

  menu.append(search, list, empty);
  document.body.append(menu);

  const state = {
    menu,
    input,
    list,
    empty,
    widget: null,
    node: null,
    folder: null,
    event: null,
    items: [],
    expanded: new Set(),
    activeIndex: -1,
    query: "",
    scrolledToSelection: false,
    visible: false,
    renderFrame: 0,
  };

  menu.addEventListener("mousedown", (event) => {
    if (event.target !== input && !event.target.closest?.(".cvmp-legacy-heading")) {
      event.preventDefault();
    }
  });
  menu.addEventListener("keydown", onLegacyMenuKeyDown);
  menu.addEventListener("keyup", (event) => event.stopPropagation());
  menu.addEventListener("click", onLegacyMenuClick);
  menu.addEventListener("pointerover", onLegacyMenuPointerOver);
  menu.addEventListener("pointerout", onLegacyMenuPointerOut);
  menu.addEventListener("dragstart", onLegacyMenuDragStart);
  menu.addEventListener("dragover", onLegacyMenuDragOver);
  menu.addEventListener("drop", onLegacyMenuDrop);
  menu.addEventListener("dragend", onLegacyMenuDragEnd);
  input.addEventListener("input", () => renderLegacyMenu());

  return state;
}

function ensureLegacyMenu() {
  legacyMenu ??= createLegacyMenu();
  return legacyMenu;
}

function closeLegacyMenu(recordWidget = false) {
  if (!legacyMenu?.visible) return;
  if (recordWidget === true) {
    legacyClosedWidget = legacyMenu.widget;
    legacyClosedAt = performance.now();
  }

  cancelAnimationFrame(legacyMenu.renderFrame);
  legacyMenu.visible = false;
  legacyMenu.menu.dataset.visible = "false";
  legacyMenu.menu.setAttribute("aria-hidden", "true");
  legacyMenu.input.blur();
  legacyMenu.input.value = "";
  legacyMenu.list.replaceChildren();
  legacyMenu.empty.hidden = true;
  legacyMenu.items = [];
  legacyMenu.expanded.clear();
  legacyMenu.activeIndex = -1;
  legacyMenu.query = "";
  legacyMenu.scrolledToSelection = false;
  legacyMenu.widget = null;
  legacyMenu.node = null;
  legacyMenu.folder = null;
  legacyMenu.event = null;
  document.removeEventListener("pointerdown", onLegacyMenuOutside, true);
  document.removeEventListener("focusin", onLegacyMenuOutside, true);
  window.removeEventListener("resize", closeLegacyMenu);
  window.removeEventListener("blur", closeLegacyMenu);
  hideCard();
}

function onLegacyMenuOutside(event) {
  if (legacyMenu?.menu.contains(event.target)) return;
  closeLegacyMenu(true);
}

function openLegacyModelMenu(widget, node, event) {
  if (!widget || !node || !widgetModelNames(widget, node).length) return false;

  if (legacyMenu?.visible) {
    if (legacyMenu.widget === widget) {
      closeLegacyMenu();
      return true;
    }
    closeLegacyMenu();
  }

  if (
    legacyClosedWidget === widget
    && performance.now() - legacyClosedAt < LEGACY_REOPEN_GUARD_MS
  ) {
    legacyClosedWidget = undefined;
    return true;
  }
  legacyClosedWidget = undefined;

  const state = ensureLegacyMenu();
  state.widget = widget;
  state.node = node;
  state.folder = widgetFolder(widget.name, node);
  state.event = event;
  const selectedName = typeof widget.value === "string" ? widget.value : "";
  state.expanded = loadExpandedCategories(state.folder) ?? new Set(
    selectedName ? [splitModelName(selectedName).category] : [],
  );
  state.visible = true;
  state.menu.dataset.visible = "true";
  state.menu.setAttribute("aria-hidden", "false");
  state.input.value = "";
  state.query = "";
  state.scrolledToSelection = false;
  renderLegacyMenu();
  positionLegacyMenu(event);
  state.input.focus({ preventScroll: true });

  document.addEventListener("pointerdown", onLegacyMenuOutside, true);
  document.addEventListener("focusin", onLegacyMenuOutside, true);
  window.addEventListener("resize", closeLegacyMenu);
  window.addEventListener("blur", closeLegacyMenu);
  return true;
}

function positionLegacyMenu(event) {
  if (!legacyMenu?.visible) return;
  const { menu, node, widget } = legacyMenu;
  const rect = menu.getBoundingClientRect();
  const mouse = app.canvas?.last_mouse ?? [0, 0];
  const pointerX = Number.isFinite(event?.clientX) ? event.clientX : mouse[0];
  const pointerY = Number.isFinite(event?.clientY) ? event.clientY : mouse[1];
  const canvasElement = app.canvas?.canvas;
  const scale = app.canvas?.ds?.scale ?? 1;
  const offset = app.canvas?.ds?.offset;
  const canvasRect = canvasElement?.getBoundingClientRect();
  const canAlignToWidget = Boolean(canvasRect && offset && node?.pos);
  const widgetLeft = canAlignToWidget
    ? canvasRect.left + (node.pos[0] + offset[0]) * scale + 8 * scale
    : pointerX - 12;
  const widgetTop = canAlignToWidget ? canvasRect.top + (node.pos[1] + offset[1]) * scale : pointerY;
  const widgetHeight = (widget?.height ?? 20) * scale;
  const widgetBottom = widgetTop + (widget?.y ?? 0) * scale + widgetHeight;
  const widgetRight = widgetLeft + Math.max(120, (node?.size?.[0] ?? 180) * scale - 16);
  let left = widgetLeft;
  let top = widgetBottom + 4;

  if (left + rect.width > window.innerWidth - LEGACY_MENU_MARGIN) {
    left = widgetRight - rect.width;
  }
  if (top + rect.height > window.innerHeight - LEGACY_MENU_MARGIN) {
    top = widgetTop + (widget?.y ?? 0) * scale - rect.height - 4;
  }

  menu.style.left = `${Math.max(
    LEGACY_MENU_MARGIN,
    Math.min(left, window.innerWidth - rect.width - LEGACY_MENU_MARGIN),
  )}px`;
  menu.style.top = `${Math.max(
    LEGACY_MENU_MARGIN,
    Math.min(top, window.innerHeight - rect.height - LEGACY_MENU_MARGIN),
  )}px`;
}

function renderLegacyMenu() {
  if (!legacyMenu?.visible || !legacyMenu.widget) return;
  const { widget, node, folder, input, list, empty } = legacyMenu;
  const query = input.value.trim().toLowerCase();
  const searching = Boolean(query);
  const preserveScroll = legacyMenu.query === query;
  const scrollTop = list.scrollTop;
  const selectedName = typeof widget.value === "string" ? widget.value : "";
  const modelNames = widgetModelNames(widget, node).filter(
    (name) => !query || name.toLowerCase().includes(query),
  );
  const groups = new Map();

  for (const name of modelNames) {
    const { category, filename } = splitModelName(name);
    const group = groups.get(category) ?? [];
    group.push({ filename, name });
    groups.set(category, group);
  }

  const categories = orderedCategories(groups.keys(), loadCategoryOrder(folder));
  const fragment = document.createDocumentFragment();
  legacyMenu.items = [];

  for (const category of categories) {
    const models = groups.get(category);
    const expanded = searching || legacyMenu.expanded.has(category);
    const group = document.createElement("section");
    group.className = "cvmp-legacy-group";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", category);

    const heading = document.createElement("button");
    heading.type = "button";
    heading.className = "cvmp-legacy-heading";
    heading.dataset.category = category;
    heading.draggable = !searching;
    heading.setAttribute("aria-expanded", String(expanded));
    heading.title = searching
      ? "搜索时自动展开"
      : `${expanded ? "收起分类" : "展开分类"}；拖拽排序`;
    const arrow = makeIcon("cvmp-legacy-arrow icon-[lucide--chevron-right]");
    const label = document.createElement("span");
    label.className = "cvmp-legacy-label";
    label.textContent = category;
    const count = document.createElement("span");
    count.className = "cvmp-legacy-count";
    count.textContent = String(models.length);
    heading.append(arrow, label, count);
    group.append(heading);

    if (!expanded) {
      fragment.append(group);
      continue;
    }

    for (const model of models) {
      const selected = model.name === selectedName;
      const item = document.createElement("button");
      item.type = "button";
      item.className = "cvmp-legacy-item";
      item.dataset.model = model.name;
      item.title = model.name;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(selected));
      if (selected) item.classList.add("is-selected");

      const name = document.createElement("span");
      name.className = "cvmp-legacy-name";
      name.textContent = model.filename;
      item.append(name);
      if (selected) item.append(makeIcon("cvmp-model-check icon-[lucide--check]"));
      group.append(item);
      legacyMenu.items.push(item);
    }
    fragment.append(group);
  }

  list.replaceChildren(fragment);
  list.scrollTop = preserveScroll ? scrollTop : 0;
  legacyMenu.query = query;
  empty.hidden = modelNames.length > 0;
  const selectedIndex = legacyMenu.items.findIndex(
    (item) => item.dataset.model === selectedName,
  );
  setLegacyActive(selectedIndex >= 0 ? selectedIndex : 0, false);

  if (selectedIndex >= 0 && !legacyMenu.scrolledToSelection) {
    legacyMenu.scrolledToSelection = true;
    cancelAnimationFrame(legacyMenu.renderFrame);
    legacyMenu.renderFrame = requestAnimationFrame(() => {
      legacyMenu?.items[selectedIndex]?.scrollIntoView({ block: "nearest" });
    });
  }
}

function setLegacyActive(index, scroll = true) {
  if (!legacyMenu?.items.length) {
    if (legacyMenu) legacyMenu.activeIndex = -1;
    return;
  }
  const next = Math.max(0, Math.min(index, legacyMenu.items.length - 1));
  legacyMenu.items[legacyMenu.activeIndex]?.classList.remove("is-active");
  legacyMenu.activeIndex = next;
  const item = legacyMenu.items[next];
  item.classList.add("is-active");
  if (scroll) item.scrollIntoView({ block: "nearest" });
}

function selectLegacyModel(modelName) {
  if (!legacyMenu?.widget || !modelName) return;
  const { widget, node, event } = legacyMenu;
  try {
    applyWidgetValue(widget, node, modelName, event);
  } finally {
    closeLegacyMenu();
  }
}

function onLegacyMenuClick(event) {
  const heading = event.target.closest?.(".cvmp-legacy-heading");
  if (heading) {
    event.preventDefault();
    if (legacyMenu.input.value.trim()) return;
    const category = heading.dataset.category;
    if (!category) return;
    if (legacyMenu.expanded.has(category)) {
      legacyMenu.expanded.delete(category);
    } else {
      legacyMenu.expanded.add(category);
    }
    saveExpandedCategories(legacyMenu.folder, legacyMenu.expanded);
    clearTimeout(hoverTimer);
    hideCard();
    renderLegacyMenu();
    return;
  }

  const item = event.target.closest?.(".cvmp-legacy-item");
  if (!item) return;
  event.preventDefault();
  selectLegacyModel(item.dataset.model);
}

function onLegacyMenuKeyDown(event) {
  event.stopPropagation();
  if (event.isComposing) return;

  if (event.key === "Escape") {
    event.preventDefault();
    closeLegacyMenu();
    return;
  }

  const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 };
  const move = moves[event.key];
  if (move) {
    event.preventDefault();
    setLegacyActive((legacyMenu?.activeIndex ?? 0) + move);
    return;
  }

  if (event.key === "Enter") {
    const item = legacyMenu?.items[legacyMenu.activeIndex];
    if (!item) return;
    event.preventDefault();
    selectLegacyModel(item.dataset.model);
  }
}

function onLegacyMenuPointerOver(event) {
  const item = event.target.closest?.(".cvmp-legacy-item");
  if (!item || !legacyMenu?.visible) return;
  clearTimeout(hoverTimer);
  clearTimeout(hideTimer);
  activeListbox = legacyMenu.menu;
  activeOption = item;
  const token = ++hoverToken;
  const index = legacyMenu.items.indexOf(item);
  if (index >= 0) setLegacyActive(index, false);
  hoverTimer = setTimeout(() => {
    showModelPreview(
      item.dataset.model,
      legacyMenu?.folder,
      legacyMenu?.menu,
      token,
      item,
    );
  }, HOVER_DELAY_MS);
}

function onLegacyMenuPointerOut(event) {
  const item = event.target.closest?.(".cvmp-legacy-item");
  if (!item) return;
  if (event.relatedTarget instanceof Node && item.contains(event.relatedTarget)) return;
  scheduleHide();
}

function clearLegacyDropIndicators() {
  for (const heading of legacyMenu?.menu.querySelectorAll(
    ".is-drop-before, .is-drop-after",
  ) ?? []) {
    heading.classList.remove("is-drop-before", "is-drop-after");
  }
}

function onLegacyMenuDragStart(event) {
  const heading = event.target.closest?.(".cvmp-legacy-heading");
  if (!heading) return;
  if (!heading.draggable) {
    event.preventDefault();
    return;
  }
  draggedCategory = {
    kind: "legacy",
    category: heading.dataset.category,
  };
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", heading.dataset.category);
  requestAnimationFrame(() => heading.classList.add("is-dragging"));
}

function onLegacyMenuDragOver(event) {
  const heading = event.target.closest?.(".cvmp-legacy-heading");
  if (
    draggedCategory?.kind !== "legacy"
    || !heading
    || !heading.draggable
    || heading.dataset.category === draggedCategory.category
  ) {
    return;
  }

  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const rect = heading.getBoundingClientRect();
  const before = event.clientY < rect.top + rect.height / 2;
  clearLegacyDropIndicators();
  heading.classList.add(before ? "is-drop-before" : "is-drop-after");
}

function onLegacyMenuDrop(event) {
  const target = event.target.closest?.(".cvmp-legacy-heading");
  if (
    draggedCategory?.kind !== "legacy"
    || !target
    || !target.draggable
    || target.dataset.category === draggedCategory.category
  ) {
    return;
  }

  event.preventDefault();
  const before = target.classList.contains("is-drop-before");
  const order = [...legacyMenu.menu.querySelectorAll(".cvmp-legacy-heading")].map(
    (heading) => heading.dataset.category,
  );
  const sourceIndex = order.indexOf(draggedCategory.category);
  if (sourceIndex < 0) return;
  order.splice(sourceIndex, 1);
  let targetIndex = order.indexOf(target.dataset.category);
  if (!before) targetIndex += 1;
  order.splice(Math.max(0, targetIndex), 0, draggedCategory.category);

  saveCategoryOrder(legacyMenu.folder, order);
  clearLegacyDropIndicators();
  renderLegacyMenu();
}

function onLegacyMenuDragEnd() {
  if (draggedCategory?.kind !== "legacy") return;
  clearLegacyDropIndicators();
  for (const heading of legacyMenu?.menu.querySelectorAll(".is-dragging") ?? []) {
    heading.classList.remove("is-dragging");
  }
  draggedCategory = null;
}

function patchLegacyModelWidgets(node) {
  for (const widget of node?.widgets ?? []) {
    if (
      widget?.type !== "combo"
      || !widgetFolder(widget.name, node)
      || patchedLegacyWidgets.has(widget)
    ) {
      continue;
    }

    const originalOnClick = widget.onClick;
    widget.onClick = function onLegacyModelClick(args) {
      if (window.LiteGraph?.vueNodesMode) {
        return originalOnClick?.call(this, args);
      }
      const handled = openLegacyModelMenu(this, node, args?.e);
      if (!handled) return originalOnClick?.call(this, args);
    };
    patchedLegacyWidgets.add(widget);
  }
}

function patchAllLegacyModelWidgets() {
  for (const node of app.graph?._nodes ?? []) patchLegacyModelWidgets(node);
}

function clearDropIndicators(tree) {
  for (const element of tree.querySelectorAll(
    ".cvmp-category.is-drop-before, .cvmp-category.is-drop-after",
  )) {
    element.classList.remove("is-drop-before", "is-drop-after");
  }
}

function renderListboxTree(listbox) {
  const context = categoryContexts.get(listbox);
  if (!context || !listbox.isConnected) return;

  const { tree, state } = context;
  const searchInput = listbox.querySelector(
    '[data-testid="widget-select-default-search-input"]',
  );
  const query = searchInput?.value.trim().toLowerCase() ?? "";
  const searching = Boolean(query);
  const widget = getWidgetForListbox(listbox);
  const options = getOptions(listbox);
  const selectedName = selectedModelName(listbox, widget, options);
  const modelNames = getModelNames(listbox).filter(
    (name) => !searching || name.toLowerCase().includes(query),
  );
  const groups = new Map();

  for (const name of modelNames) {
    const { category, filename } = splitModelName(name);
    const group = groups.get(category) ?? [];
    group.push({ filename, name });
    groups.set(category, group);
  }

  if (!state.initialized) {
    if (selectedName) {
      state.expanded.add(splitModelName(selectedName).category);
    }
    state.initialized = true;
  }

  const highlighted = options.find((option) => option.hasAttribute("data-highlighted"));
  const highlightedCategory = highlighted
    ? splitModelName(optionName(highlighted)).category
    : null;
  if (highlightedCategory && highlightedCategory !== state.highlightedCategory) {
    state.expanded.add(highlightedCategory);
    state.highlightedCategory = highlightedCategory;
  }

  const categories = orderedCategories(groups.keys(), state.order);
  if (!searching && categories.length) state.order = categories;

  const scrollTop = tree.scrollTop;
  const fragment = document.createDocumentFragment();
  for (const category of categories) {
    const models = groups.get(category);
    const expanded = searching || state.expanded.has(category);
    const selectedInGroup = models.some((model) => model.name === selectedName);

    const group = document.createElement("section");
    group.className = "cvmp-category-group";

    const header = document.createElement("button");
    header.type = "button";
    header.className = "cvmp-category";
    header.dataset.category = category;
    header.draggable = !searching;
    header.setAttribute("aria-expanded", String(expanded));
    header.title = searching ? "" : "拖拽排序";
    if (selectedInGroup) header.dataset.selected = "true";

    const arrow = makeIcon("cvmp-category-arrow icon-[lucide--chevron-right]");
    const label = document.createElement("span");
    label.className = "cvmp-category-label";
    label.textContent = category;

    const count = document.createElement("span");
    count.className = "cvmp-category-count";
    count.textContent = String(models.length);
    header.append(arrow, label, count);
    group.append(header);

    if (expanded) {
      const items = document.createElement("div");
      items.className = "cvmp-category-items";
      items.setAttribute("role", "group");
      for (const model of models) {
        const selected = model.name === selectedName;
        const item = document.createElement("button");
        item.type = "button";
        item.className = "cvmp-model-item";
        item.dataset.model = model.name;
        item.title = model.name;
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(selected));
        item.tabIndex = -1;
        if (selected) item.dataset.selected = "true";

        const name = document.createElement("span");
        name.className = "cvmp-model-name";
        name.textContent = model.filename;
        item.append(name);
        if (selected) item.append(makeIcon("cvmp-model-check icon-[lucide--check]"));
        items.append(item);
      }
      group.append(items);
    }
    fragment.append(group);
  }

  tree.replaceChildren(fragment);
  tree.scrollTop = scrollTop;
  if (!state.scrolledToSelection && selectedName) {
    state.scrolledToSelection = true;
    requestAnimationFrame(() => {
      const selectedItem = [...tree.querySelectorAll(".cvmp-model-item")].find(
        (item) => item.dataset.model === selectedName,
      );
      if (!selectedItem) return;
      const treeRect = tree.getBoundingClientRect();
      const itemRect = selectedItem.getBoundingClientRect();
      tree.scrollTop += itemRect.top - treeRect.top - 32;
    });
  }
}

function scheduleTreeRender(listbox) {
  const context = categoryContexts.get(listbox);
  if (!context) return;
  cancelAnimationFrame(context.renderFrame);
  context.renderFrame = requestAnimationFrame(() => renderListboxTree(listbox));
}

function onTreeClick(event) {
  const tree = event.currentTarget;
  const listbox = tree.closest('[data-testid="widget-select-default-overlay"]');
  const context = categoryContexts.get(listbox);
  if (!context) return;

  const header = event.target.closest?.(".cvmp-category");
  if (header) {
    const category = header.dataset.category;
    if (context.state.expanded.has(category)) {
      context.state.expanded.delete(category);
    } else {
      context.state.expanded.add(category);
    }
    saveExpandedCategories(context.folder, context.state.expanded);
    renderListboxTree(listbox);
    return;
  }

  const item = event.target.closest?.(".cvmp-model-item");
  if (!item) return;
  event.preventDefault();
  selectModel(listbox, item.dataset.model);
}

function onTreeDragStart(event) {
  const header = event.target.closest?.(".cvmp-category");
  if (!header || !header.draggable) {
    event.preventDefault();
    return;
  }
  const listbox = header.closest('[data-testid="widget-select-default-overlay"]');
  draggedCategory = {
    category: header.dataset.category,
    listbox,
  };
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", header.dataset.category);
  requestAnimationFrame(() => header.classList.add("is-dragging"));
}

function onTreeDragOver(event) {
  const header = event.target.closest?.(".cvmp-category");
  if (!draggedCategory?.listbox || !header || !header.draggable) return;
  if (header.dataset.category === draggedCategory.category) return;
  if (header.closest('[data-testid="widget-select-default-overlay"]') !== draggedCategory.listbox) {
    return;
  }

  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const rect = header.getBoundingClientRect();
  const before = event.clientY < rect.top + rect.height / 2;
  const tree = header.closest(".cvmp-tree");
  clearDropIndicators(tree);
  header.classList.add(before ? "is-drop-before" : "is-drop-after");
}

function onTreeDrop(event) {
  const header = event.target.closest?.(".cvmp-category");
  if (!draggedCategory?.listbox || !header || !header.draggable) return;
  if (header.closest('[data-testid="widget-select-default-overlay"]') !== draggedCategory.listbox) {
    return;
  }

  event.preventDefault();
  const tree = header.closest(".cvmp-tree");
  const listbox = draggedCategory.listbox;
  const context = categoryContexts.get(listbox);
  if (!context) return;

  const before = header.classList.contains("is-drop-before");
  const order = [...tree.querySelectorAll(".cvmp-category")].map(
    (element) => element.dataset.category,
  );
  const sourceIndex = order.indexOf(draggedCategory.category);
  if (sourceIndex < 0) return;
  order.splice(sourceIndex, 1);
  let targetIndex = order.indexOf(header.dataset.category);
  if (!before) targetIndex += 1;
  order.splice(Math.max(0, targetIndex), 0, draggedCategory.category);

  context.state.order = order;
  saveCategoryOrder(context.folder, order);
  clearDropIndicators(tree);
  renderListboxTree(listbox);
}

function onTreeDragEnd(event) {
  const tree = event.currentTarget;
  clearDropIndicators(tree);
  for (const element of tree.querySelectorAll(".is-dragging")) {
    element.classList.remove("is-dragging");
  }
  draggedCategory = null;
}

function ensureCategorizedListbox(listbox) {
  if (categoryContexts.has(listbox) || listbox.getBoundingClientRect().width === 0) {
    return;
  }
  const source = listbox.querySelector(
    '[data-testid="widget-select-default-viewport"]',
  );
  const folder = getListboxFolder(listbox);
  if (!source || !folder || !getModelNames(listbox).length) return;

  const tree = document.createElement("div");
  tree.className = "cvmp-tree";
  tree.setAttribute("role", "tree");
  source.after(tree);
  source.classList.add("cvmp-category-source");

  const savedExpanded = loadExpandedCategories(folder);
  const context = {
    folder,
    source,
    tree,
    state: {
      expanded: savedExpanded ?? new Set(),
      initialized: savedExpanded !== null,
      highlightedCategory: null,
      order: loadCategoryOrder(folder),
      scrolledToSelection: false,
    },
    renderFrame: 0,
  };
  categoryContexts.set(listbox, context);

  tree.addEventListener("click", onTreeClick);
  tree.addEventListener("dragstart", onTreeDragStart);
  tree.addEventListener("dragover", onTreeDragOver);
  tree.addEventListener("drop", onTreeDrop);
  tree.addEventListener("dragend", onTreeDragEnd);

  new MutationObserver(() => scheduleTreeRender(listbox)).observe(source, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-highlighted", "data-state", "aria-selected"],
  });

  listbox
    .querySelector('[data-testid="widget-select-default-search-input"]')
    ?.addEventListener("input", () => scheduleTreeRender(listbox));
  renderListboxTree(listbox);
}

function prefetchOption(modelName, listbox) {
  const folder = getListboxFolder(listbox);
  if (!folder || !modelName) return;

  resolveModel(folder, modelName).then((model) => {
    if (model) loadPreview(previewUrl(folder, model));
  });
}

function prefetchAround(modelName, listbox) {
  const modelNames = getModelNames(listbox);
  const index = modelNames.indexOf(modelName);
  if (index < 0) return;

  const start = Math.max(0, index - PREFETCH_RADIUS);
  const end = Math.min(modelNames.length, index + PREFETCH_RADIUS + 1);
  for (let current = start; current < end; current += 1) {
    prefetchOption(modelNames[current], listbox);
  }
}

function prefetchOpenListboxes() {
  const listboxes = document.querySelectorAll(
    '[data-testid="widget-select-default-overlay"]',
  );
  for (const listbox of listboxes) {
    if (listbox.getBoundingClientRect().width === 0) continue;
    ensureCategorizedListbox(listbox);
    if (prefetchedListboxes.has(listbox)) continue;
    const modelNames = getModelNames(listbox);
    if (!modelNames.length || !getListboxFolder(listbox)) continue;

    prefetchedListboxes.add(listbox);
    for (const modelName of modelNames.slice(0, PREFETCH_COUNT)) {
      prefetchOption(modelName, listbox);
    }
  }
}

function scheduleListboxScan() {
  cancelAnimationFrame(scanFrame);
  scanFrame = requestAnimationFrame(prefetchOpenListboxes);
}

function createCard() {
  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = new URL("./vue_model_preview.css", import.meta.url).href;
  style.dataset.vueModelPreview = "true";
  document.head.append(style);

  const card = document.createElement("div");
  card.className = "cvmp-card";
  card.setAttribute("aria-hidden", "true");

  const image = document.createElement("img");
  image.className = "cvmp-image";
  image.alt = "";
  image.decoding = "async";

  const caption = document.createElement("div");
  caption.className = "cvmp-caption";

  card.append(image, caption);
  document.body.append(card);
  return { card, image, caption };
}

function hideCard() {
  clearTimeout(hoverTimer);
  clearTimeout(hideTimer);
  cancelAnimationFrame(animationFrame);
  hoverTimer = undefined;
  hideTimer = undefined;
  animationFrame = undefined;
  hoverToken += 1;
  activeOption = null;
  activeListbox = null;
  card.dataset.visible = "false";
  card.setAttribute("aria-hidden", "true");
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideCard, HIDE_DELAY_MS);
}

function positionCard(listbox, option) {
  if (!card.dataset.visible || activeListbox !== listbox || activeOption !== option) return;
  if (!listbox.isConnected || !option.isConnected) {
    hideCard();
    return;
  }

  const listRect = listbox.getBoundingClientRect();
  const optionRect = option.getBoundingClientRect();
  const cardWidth = card.offsetWidth;
  const cardHeight = card.offsetHeight;
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;

  let left = listRect.right + CARD_GAP_PX;
  if (left + cardWidth > viewportWidth - CARD_GAP_PX) {
    left = listRect.left - cardWidth - CARD_GAP_PX;
  }
  left = Math.max(CARD_GAP_PX, Math.min(left, viewportWidth - cardWidth - CARD_GAP_PX));

  const top = Math.min(listRect.top, optionRect.top);
  const maxTop = Math.max(CARD_GAP_PX, viewportHeight - cardHeight - CARD_GAP_PX);
  card.style.left = `${left}px`;
  card.style.top = `${Math.max(CARD_GAP_PX, Math.min(top, maxTop))}px`;
}

function watchListbox(listbox, option) {
  cancelAnimationFrame(animationFrame);
  const tick = () => {
    if (activeListbox !== listbox || activeOption !== option) return;
    if (!listbox.isConnected || !option.isConnected) {
      hideCard();
      return;
    }
    positionCard(listbox, option);
    animationFrame = requestAnimationFrame(tick);
  };
  animationFrame = requestAnimationFrame(tick);
}

function getTrigger(listbox) {
  if (!listbox.id) return null;
  return (
    [...document.querySelectorAll('button[role="combobox"]')].find(
      (trigger) => trigger.getAttribute("aria-controls") === listbox.id,
    ) ?? null
  );
}

function getWidget(trigger) {
  const node = getTriggerNode(trigger);
  if (!node?.widgets) return null;

  const nodeElement = trigger.closest("[data-node-id], [node-id]");
  const triggers = [...nodeElement.querySelectorAll('button[role="combobox"]')];
  const triggerIndex = triggers.indexOf(trigger);
  const combos = node.widgets.filter((widget) => widget.type === "combo");
  return combos[triggerIndex] ?? null;
}

function getTriggerNode(trigger) {
  const nodeElement = trigger.closest("[data-node-id], [node-id]");
  const nodeId =
    nodeElement?.getAttribute("data-node-id")
    || nodeElement?.getAttribute("node-id");
  if (!nodeElement || !nodeId) return null;

  const node = app.graph?.getNodeById?.(Number.isNaN(Number(nodeId)) ? nodeId : Number(nodeId));
  return node ?? null;
}

async function showPreview(modelName, listbox, token, anchor) {
  const widget = getWidgetForListbox(listbox);
  const trigger = widget ? getTrigger(listbox) : null;
  const node = trigger ? getTriggerNode(trigger) : null;
  const folder = widget?.name ? widgetFolder(widget.name, node) : null;
  await showModelPreview(modelName, folder, listbox, token, anchor);
}

async function showModelPreview(modelName, folder, listbox, token, anchor) {
  if (!folder || !modelName || !listbox || !anchor) return;
  const model = await resolveModel(folder, modelName);
  if (!model || token !== hoverToken) return;

  const url = await loadPreview(previewUrl(folder, model));
  if (!url || token !== hoverToken) return;
  if (!anchor.isConnected || !listbox.isConnected) return;

  activeOption = anchor;
  activeListbox = listbox;
  if (image.src !== url) image.src = url;
  caption.textContent = model.name.split(/[\\/]/).pop() ?? model.name;
  card.dataset.visible = "true";
  card.setAttribute("aria-hidden", "false");

  positionCard(listbox, anchor);
  watchListbox(listbox, anchor);
}

function onPointerOver(event) {
  const item = event.target.closest?.(".cvmp-model-item");
  const listbox = (item ?? event.target).closest?.(
    '[data-testid="widget-select-default-overlay"]',
  );
  const option = item
    ? null
    : event.target.closest?.('[role="option"]');
  const modelName = item?.dataset.model ?? (option ? optionName(option) : "");
  if (!modelName || !listbox) return;
  const anchor = item ?? option;

  clearTimeout(hoverTimer);
  clearTimeout(hideTimer);
  activeOption = anchor;
  activeListbox = listbox;
  const token = ++hoverToken;
  prefetchAround(modelName, listbox);

  hoverTimer = setTimeout(() => {
    showPreview(modelName, listbox, token, anchor);
  }, HOVER_DELAY_MS);
}

function onPointerOut(event) {
  const anchor =
    event.target.closest?.(".cvmp-model-item")
    ?? event.target.closest?.('[role="option"]');
  if (!anchor) return;
  if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) return;
  scheduleHide();
}

if (!window.__comfyVueModelPreviewInstalled) {
  window.__comfyVueModelPreviewInstalled = true;

  ({ card, image, caption } = createCard());
  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("pointerout", onPointerOut, true);
  document.addEventListener("click", scheduleListboxScan, true);
  document.addEventListener("focusin", scheduleListboxScan, true);
  new MutationObserver(scheduleListboxScan).observe(document.body, {
    childList: true,
    subtree: true,
  });
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!activeListbox?.contains(event.target)) hideCard();
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") hideCard();
    },
    true,
  );

  try {
    app.registerExtension({
      name: "ComfyUI.VueModelPreview",
      setup() {
        patchAllLegacyModelWidgets();
        queueMicrotask(patchAllLegacyModelWidgets);
      },
      nodeCreated(node) {
        patchLegacyModelWidgets(node);
        queueMicrotask(() => patchLegacyModelWidgets(node));
      },
    });
  } catch (error) {
    if (!String(error?.message).includes("already registered")) throw error;
  }
}
