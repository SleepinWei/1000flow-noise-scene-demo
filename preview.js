const byId = id => document.getElementById(id);
const steps = byId('steps');
const model = byId('scene');
const modelFallback = byId('model-fallback');
const modelDownload = byId('download-model');
const modelReset = byId('reset-model');
const modelProgress = byId('model-progress');
const badge = byId('run-badge');
const runMessage = byId('run-message');
const layerTabs = [...document.querySelectorAll('.layer-tab')];
const layerImage = byId('annotation-image');
const imageDialog = byId('image-dialog');
const imageOpen = byId('open-image');
const imageDownload = byId('download-image');
const uploadDialog = byId('upload-dialog');
const uploadOpen = byId('open-upload');
const uploadForm = byId('upload-form');
const submitPhoto = byId('submit-photo');

const initialOrbit = '34deg 61deg auto';
const stateNames = {waiting: '等待任务', running: '处理中', ready: '复核通过', attention: '待处理', offline: '连接中断'};
const stepNames = {pending: '待开始', active: '进行中', done: '已完成', reused: '已复用', attention: '待处理'};
const layerNames = {input: '输入照片', noise: '潜在噪声点', retrofit: '拟改造位置'};
const numberFormat = new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 1});

let result = null;
let layer = null;
let modelSource = '';
let workflowKey = '';
let catalog;
let selectionVersion = 0;
let pollTimer;
let submissionId;
const jobPattern = /^[0-9a-f]{32}$/;
const jobsKey = '1000flow.scene-jobs.v1';

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function showStatus(state, message) {
  badge.dataset.state = state;
  setText(badge, stateNames[state]);
  setText(runMessage, message);
}

function showWorkflow(data) {
  showStatus(data.state, data.message);
  const key = JSON.stringify([data.steps, data.history]);
  if (workflowKey === key) return;
  workflowKey = key;

  const nodes = data.steps.map((step, index) => {
    const row = document.createElement('li');
    row.className = 'step';
    row.dataset.state = step.state;
    if (step.state === 'active') row.setAttribute('aria-current', 'step');
    const number = String(index + 1).padStart(2, '0');
    for (const [name, text] of [['node', number], ['step-name', step.label], ['step-state', stepNames[step.state]]]) {
      const span = document.createElement('span');
      span.className = name;
      span.textContent = text;
      row.append(span);
    }
    return row;
  });
  steps.replaceChildren(...nodes);
  const done = data.steps.filter(step => step.state === 'done' || step.state === 'reused').length;
  const total = byId('progress-total');
  setText(total, `${done} / ${nodes.length}`);
  total.setAttribute('aria-label', `${done} 个步骤已完成，共 ${nodes.length} 个步骤`);
  const history = (data.history || []).map(round => {
    const row = document.createElement('li');
    row.textContent = `第 ${round.round} 轮 · ${round.label}`;
    return row;
  });
  byId('round-history').hidden = history.length === 0;
  byId('rounds').replaceChildren(...history);
}

function showModelFallback() {
  model.hidden = true;
  modelReset.hidden = true;
  byId('axis-hint').hidden = true;
  modelFallback.hidden = !result?.poster;
  byId('model-empty').hidden = Boolean(result?.poster);
  setText(byId('model-empty'), '三维预览暂不可用，可下载 GLB 查看。');
  setText(byId('model-info'), '三维预览加载失败，可下载 GLB 查看。');
}

function showModel(data) {
  if (!data) {
    if (modelSource) model.removeAttribute('src');
    model.removeAttribute('poster');
    modelSource = '';
    model.hidden = modelDownload.hidden = modelReset.hidden = modelFallback.hidden = true;
    byId('model-empty').hidden = false;
    byId('axis-hint').hidden = true;
    setText(byId('model-empty'), '视觉复核完成后可查看整景。');
    setText(byId('model-info'), '整景模型以可编辑 GLB 交付。');
    return;
  }
  if (modelSource === data.model) return;
  modelSource = data.model;
  modelDownload.href = data.model;
  modelDownload.hidden = false;
  if (data.poster) {
    model.setAttribute('poster', data.poster);
    modelFallback.src = data.poster;
  }
  if (!customElements.get('model-viewer')) {
    showModelFallback();
    return;
  }
  byId('model-empty').hidden = true;
  modelFallback.hidden = true;
  model.hidden = modelProgress.hidden = false;
  modelProgress.value = 0;
  model.src = data.model;
  const metadata = [`${numberFormat.format(data.bytes / 2 ** 20)} MiB`];
  if (data.meshes) metadata.unshift(`${data.meshes} 个可编辑对象`);
  if (data.reduction) {
    const reduction = (1 - data.reduction.after / data.reduction.before) * 100;
    metadata.push(`构件减面 ${numberFormat.format(reduction)}%`);
  }
  setText(byId('model-info'), metadata.join(' · '));
}

function activeLayer() {
  if (result?.input) return layer || 'input';
  return layer && layer !== 'input' ? layer : 'noise';
}

function layerData(kind) {
  return kind === 'input' ? result?.input : result?.layers[kind];
}

function showLayer() {
  const kind = activeLayer();
  const data = layerData(kind);
  const title = layerNames[kind];
  byId('layer-panel').setAttribute('aria-labelledby', `tab-${kind}`);
  for (const tab of layerTabs) {
    tab.hidden = tab.dataset.kind === 'input' && !result?.input;
    const active = tab.dataset.kind === kind;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  imageOpen.hidden = imageDownload.hidden = layerImage.hidden = !data;
  byId('image-empty').hidden = Boolean(data);
  if (!data) {
    setText(byId('image-empty'), result ? '这个图层暂无可展示的标注。' : '整景生成后可查看标注图层。');
    setText(byId('image-info'), '箭头标注在 2D 渲染图上。');
    return;
  }
  if (layerImage.getAttribute('src') !== data.image) layerImage.src = data.image;
  imageDownload.href = data.image;
  if (kind === 'input') {
    layerImage.alt = `${byId('project-title').textContent}的建模输入照片`;
    imageDownload.download = `输入照片.${data.image.split('.').pop()}`;
    setText(imageDownload, '下载输入');
    setText(byId('image-info'), `${data.size_px.join(' × ')} px${data.note ? ` · ${data.note}` : ' · 实际建模输入'}`);
  } else {
    layerImage.alt = `整景渲染中的${title}箭头标注`;
    imageDownload.download = `${title}.png`;
    setText(imageDownload, '下载 PNG');
    setText(byId('image-info'), `${data.placed} 处已标记${data.pending ? ` · ${data.pending} 处待定位` : ''}`);
  }
}

for (const tab of layerTabs) {
  tab.addEventListener('click', () => {
    layer = tab.dataset.kind;
    showLayer();
  });
  tab.addEventListener('keydown', event => {
    const visible = layerTabs.filter(item => !item.hidden);
    const index = visible.indexOf(tab);
    const last = visible.length - 1;
    const nextIndex = {ArrowLeft: index ? index - 1 : last, ArrowRight: index === last ? 0 : index + 1,
      Home: 0, End: last}[event.key];
    if (nextIndex === undefined) return;
    event.preventDefault();
    visible[nextIndex].click();
    visible[nextIndex].focus();
  });
}

model.addEventListener('progress', event => { modelProgress.value = event.detail.totalProgress; });
model.addEventListener('load', () => {
  if (!result?.model || model.hidden) return;
  modelProgress.hidden = true;
  modelReset.hidden = false;
  byId('axis-hint').hidden = false;
});
model.addEventListener('error', () => { if (result?.model) showModelFallback(); });
modelReset.addEventListener('click', () => {
  model.cameraOrbit = initialOrbit;
  model.cameraTarget = 'auto auto auto';
  model.fieldOfView = 'auto';
  model.jumpCameraToGoal();
});

imageOpen.addEventListener('click', () => {
  const kind = activeLayer();
  const data = layerData(kind);
  if (!data) return;
  const largeImage = byId('large-image');
  largeImage.src = data.image;
  largeImage.alt = layerImage.alt;
  setText(byId('dialog-title'), layerNames[kind]);
  imageDialog.showModal();
});
byId('close-image').addEventListener('click', () => imageDialog.close());
imageDialog.addEventListener('close', () => imageOpen.focus());

function selectionLink(key, identifier) {
  const url = new URL(location.href);
  url.searchParams.delete('case');
  url.searchParams.delete('job');
  url.searchParams.set(key, identifier);
  return url;
}

function routeLink(link, key, identifier) {
  link.href = selectionLink(key, identifier);
  link.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    history.pushState(null, '', selectionLink(key, identifier));
    selectScene();
  });
}

function savedJobs() {
  try {
    const jobs = JSON.parse(localStorage.getItem(jobsKey) || '[]');
    return Array.isArray(jobs) ? jobs.filter(job => jobPattern.test(job.id) && typeof job.title === 'string') : [];
  } catch {
    return [];
  }
}

function rememberJob(job) {
  try {
    const list = [job, ...savedJobs().filter(existing => existing.id !== job.id)].slice(0, 8);
    localStorage.setItem(jobsKey, JSON.stringify(list));
  } catch {
    // The job link in the address bar still works when browser storage is unavailable.
  }
}

function showRecentJobs() {
  const rows = savedJobs().map(job => {
    const row = document.createElement('li');
    const link = document.createElement('a');
    link.textContent = job.title;
    routeLink(link, 'job', job.id);
    row.append(link);
    return row;
  });
  byId('job-list').hidden = !catalog.workspace || !rows.length;
  byId('recent-jobs').replaceChildren(...rows);
}

function showCases() {
  const links = catalog.scenes.map((scene, index) => {
    const link = document.createElement('a');
    link.className = 'case-choice';
    link.dataset.case = scene.id;
    const number = document.createElement('span');
    number.className = 'case-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const name = document.createElement('span');
    name.textContent = scene.title;
    link.append(number, name);
    routeLink(link, 'case', scene.id);
    return link;
  });
  byId('case-menu').replaceChildren(...links);
  byId('case-bar').hidden = links.length < 2;
  setText(byId('case-count'), `${links.length} 个场景`);
}

async function readStatus(url, version, live) {
  try {
    const response = await fetch(url, {cache: live ? 'no-store' : 'no-cache', signal: AbortSignal.timeout(8000)});
    if (version !== selectionVersion) return;
    if (response.status === 404 && live) {
      showStatus('attention', '找不到这个任务。请检查链接，或从场景样例返回。');
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (version !== selectionVersion) return;
    setText(byId('project-title'), data.title);
    document.title = `${data.title} · 汇千流`;
    showWorkflow(data);
    result = data.result;
    showModel(result);
    showLayer();
  } catch {
    if (version !== selectionVersion) return;
    showStatus('offline', live ? '暂时读不到进度，页面将自动重试。' : '暂时读不到这个场景，请重新选择或刷新页面。');
  }
  if (live && version === selectionVersion) {
    pollTimer = setTimeout(() => readStatus(url, version, live), document.hidden ? 5000 : 1500);
  }
}

function selectScene() {
  const version = ++selectionVersion;
  clearTimeout(pollTimer);
  const query = new URLSearchParams(location.search);
  const job = query.get('job');
  const isJob = catalog.workspace && job && jobPattern.test(job);
  const selected = catalog.scenes.find(scene => scene.id === query.get('case')) ||
    catalog.scenes.find(scene => scene.id === catalog.default_scene) || catalog.scenes[0];
  for (const link of byId('case-menu').querySelectorAll('.case-choice')) {
    if (!isJob && link.dataset.case === selected.id) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  result = null;
  layer = null;
  workflowKey = '';
  steps.replaceChildren();
  byId('round-history').hidden = true;
  byId('round-history').open = false;
  setText(byId('progress-total'), '—');
  setText(byId('project-title'), isJob ? '建模任务' : selected.title);
  showStatus('waiting', '正在读取处理记录');
  showModel(null);
  showLayer();
  readStatus(isJob ? `${catalog.workspace.jobs}/${job}/status` : selected.status, version, isJob || selected.live);
}

function uploadError(message) {
  const error = byId('upload-error');
  setText(error, message);
  error.hidden = !message;
}

uploadOpen.addEventListener('click', () => {
  uploadError(catalog.workspace.available ? '' : '生成服务待配置，请联系工作台管理员。');
  submitPhoto.disabled = !catalog.workspace.available;
  uploadDialog.showModal();
});
byId('close-upload').addEventListener('click', () => uploadDialog.close());
uploadDialog.addEventListener('close', () => uploadOpen.focus());
uploadForm.addEventListener('input', () => { submissionId = null; uploadError(''); });

uploadForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!catalog.workspace.available || submitPhoto.disabled) return;
  const file = byId('scene-photo').files[0];
  const title = byId('scene-name').value.trim();
  if (!title || !file || !['image/jpeg', 'image/png'].includes(file.type) || file.size > catalog.workspace.max_bytes) {
    uploadError('请输入任务名称，并选择符合大小限制的 JPG 或 PNG。');
    return;
  }
  submissionId ||= crypto.randomUUID();
  const headers = {'Content-Type': file.type, 'X-Scene-Title': encodeURIComponent(title), 'X-Submission-ID': submissionId};
  if (catalog.workspace.requires_code) headers['X-Workspace-Code'] = encodeURIComponent(byId('workspace-code').value);
  submitPhoto.disabled = true;
  setText(submitPhoto, '正在提交…');
  try {
    const response = await fetch(catalog.workspace.jobs, {method: 'POST', headers, body: file, signal: AbortSignal.timeout(45000)});
    const data = await response.json();
    if (!response.ok) { uploadError(data.message || '提交失败，请检查照片后重试。'); return; }
    rememberJob(data);
    showRecentJobs();
    uploadForm.reset();
    submissionId = null;
    uploadDialog.close();
    history.pushState(null, '', selectionLink('job', data.id));
    selectScene();
  } catch {
    uploadError('暂时无法连接。再次提交会沿用本次请求。');
  } finally {
    submitPhoto.disabled = false;
    setText(submitPhoto, '提交并生成');
  }
});

window.addEventListener('popstate', () => { if (catalog) selectScene(); });

async function initialize() {
  try {
    const response = await fetch('./site.json', {cache: 'no-cache'});
    if (!response.ok) throw new Error('catalog unavailable');
    catalog = await response.json();
    showCases();
    showRecentJobs();
    if (catalog.workspace) {
      setText(byId('page-mode'), '项目工作台');
      uploadOpen.hidden = false;
      byId('code-field').hidden = !catalog.workspace.requires_code;
      byId('workspace-code').required = catalog.workspace.requires_code;
      setText(byId('upload-note'), catalog.workspace.tripo_budget
        ? '照片用于 Kimi 建模与复核，选中的构件裁片可交给 Tripo 生成。'
        : '照片用于 Kimi 建模与复核，构件由 Blender 组装。');
    } else if (catalog.mode === 'samples') {
      setText(byId('page-mode'), '公开案例库');
      if (catalog.workspace_url) {
        byId('workspace-link').href = catalog.workspace_url;
        byId('workspace-link').hidden = false;
      }
    }
    selectScene();
  } catch {
    showStatus('offline', '暂时读不到场景列表，请刷新页面。');
  }
}

initialize();
