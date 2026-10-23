import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const FOLDER_PATTERNS = [
  [/^ckpt(?:_name)?\d*$/, "checkpoints"],
  [/^checkpoint(?:_name)?\d*$/, "checkpoints"],
  [/^lora(?:_name)?\d*$/, "loras"],
  [/^vae(?:_name)?\d*$/, "vae"],
  [/^control_net(?:_name)?\d*$/, "controlnet"],
  [/^(?:unet|diffusion_model)(?:_name)?\d*$/, "diffusion_models"],
  [/^(?:clip|text_encoder)(?:_name)?\d*$/, "text_encoders"],
  [/^upscale_model(?:_name)?\d*$/, "upscale_models"],
];

const HOVER_DELAY_MS = 16;
const HIDE_DELAY_MS = 80;
const CARD_GAP_PX = 8;
const PREFETCH_COUNT = 8;
const PREFETCH_RADIUS = 2;
const UNCATEGORIZED = "未分类";
const CATEGORY_STORAGE_PREFIX = "cvmp.categoryOrder.v1";

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
const categoryCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
let draggedCategory = null;

function widgetFolder(widgetName) {
  const normalized = widgetName.toLowerCase();
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

function getListboxFolder(listbox) {
  if (listboxFolders.has(listbox)) return listboxFolders.get(listbox);

  const trigger = getTrigger(listbox);
  const widget = trigger ? getWidget(trigger) : null;
  const folder = widget?.name ? widgetFolder(widget.name) : null;
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
  const searching = Boolean(searchInput?.value.trim());
  const options = getOptions(listbox);
  const groups = new Map();
  const selectedName = options.find(
    (option) => option.getAttribute("aria-selected") === "true",
  )?.getAttribute("textvalue");

  for (const option of options) {
    const name = optionName(option);
    if (!name) continue;
    const { category, filename } = splitModelName(name);
    const group = groups.get(category) ?? [];
    group.push({ filename, name, option });
    groups.set(category, group);
  }

  if (!state.initialized) {
    const selected = options.find(
      (option) => option.getAttribute("aria-selected") === "true",
    );
    if (selected) {
      state.expanded.add(splitModelName(optionName(selected)).category);
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
    const selectedInGroup = models.some(
      (model) => model.option.getAttribute("aria-selected") === "true",
    );

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
        const selected = model.option.getAttribute("aria-selected") === "true";
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
    renderListboxTree(listbox);
    return;
  }

  const item = event.target.closest?.(".cvmp-model-item");
  if (!item) return;
  const option = findSourceOption(listbox, item.dataset.model);
  if (!option) return;
  event.preventDefault();
  option.click();
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
  if (!source || !folder || !getOptions(listbox).length) return;

  const tree = document.createElement("div");
  tree.className = "cvmp-tree";
  tree.setAttribute("role", "tree");
  source.after(tree);
  source.classList.add("cvmp-category-source");

  const context = {
    folder,
    source,
    tree,
    state: {
      expanded: new Set(),
      initialized: false,
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

function prefetchOption(option, listbox) {
  const folder = getListboxFolder(listbox);
  const modelName = optionName(option);
  if (!folder || !modelName) return;

  resolveModel(folder, modelName).then((model) => {
    if (model) loadPreview(previewUrl(folder, model));
  });
}

function prefetchAround(option, listbox) {
  const options = getOptions(listbox);
  const index = options.indexOf(option);
  if (index < 0) return;

  const start = Math.max(0, index - PREFETCH_RADIUS);
  const end = Math.min(options.length, index + PREFETCH_RADIUS + 1);
  for (let current = start; current < end; current += 1) {
    prefetchOption(options[current], listbox);
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
    const options = getOptions(listbox);
    if (!options.length || !getListboxFolder(listbox)) continue;

    prefetchedListboxes.add(listbox);
    for (const option of options.slice(0, PREFETCH_COUNT)) {
      prefetchOption(option, listbox);
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
  const nodeElement = trigger.closest("[node-id]");
  const nodeId = nodeElement?.getAttribute("node-id");
  if (!nodeElement || !nodeId) return null;

  const node = app.graph?.getNodeById?.(Number.isNaN(Number(nodeId)) ? nodeId : Number(nodeId));
  if (!node?.widgets) return null;

  const triggers = [...nodeElement.querySelectorAll('button[role="combobox"]')];
  const triggerIndex = triggers.indexOf(trigger);
  const combos = node.widgets.filter((widget) => widget.type === "combo");
  return combos[triggerIndex] ?? null;
}

async function showPreview(option, listbox, token, anchor = option) {
  const trigger = getTrigger(listbox);
  const widget = trigger ? getWidget(trigger) : null;
  const folder = widget?.name ? widgetFolder(widget.name) : null;
  const modelName = optionName(option);
  if (!folder || !modelName) return;

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
    ? findSourceOption(listbox, item.dataset.model)
    : event.target.closest?.('[role="option"]');
  if (!option || !listbox) return;
  const anchor = item ?? option;

  clearTimeout(hoverTimer);
  clearTimeout(hideTimer);
  activeOption = anchor;
  activeListbox = listbox;
  const token = ++hoverToken;
  prefetchAround(option, listbox);

  hoverTimer = setTimeout(() => {
    showPreview(option, listbox, token, anchor);
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
    app.registerExtension({ name: "ComfyUI.VueModelPreview" });
  } catch (error) {
    if (!String(error?.message).includes("already registered")) throw error;
  }
}
