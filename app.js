(() => {
  'use strict';

  // ---------- DOM参照 ----------
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const dzFilename = document.getElementById('dz-filename');

  const progressArea = document.getElementById('progress-area');
  const progressPhaseEl = document.getElementById('progress-phase');
  const progressPercentEl = document.getElementById('progress-percent');
  const progressBarEl = document.getElementById('progress-bar');
  const errorBanner = document.getElementById('error-banner');

  const panelMode = document.getElementById('panel-mode');
  const modeTabs = Array.from(document.querySelectorAll('.mode-tab'));
  const modeHelp = document.getElementById('mode-help');
  const queryForm = document.getElementById('query-form');
  const queryLabel = document.getElementById('query-label');
  const queryInput = document.getElementById('query-input');
  const queryHint = document.getElementById('query-hint');
  const suggestionsList = document.getElementById('command-suggestions');

  const panelSummary = document.getElementById('panel-summary');
  const statLines = document.getElementById('stat-lines');
  const statCommands = document.getElementById('stat-commands');
  const statRoots = document.getElementById('stat-roots');
  const statPlayers = document.getElementById('stat-players');
  const statTime = document.getElementById('stat-time');

  const panelResult = document.getElementById('panel-result');
  const breadcrumbEl = document.getElementById('breadcrumb');
  const resultMessage = document.getElementById('result-message');
  const resultTree = document.getElementById('result-tree');
  const resultRanking = document.getElementById('result-ranking');

  // ---------- 状態 ----------
  let currentWorker = null;
  let trieRoot = null;
  let currentMode = 'all';

  // ---------- ユーティリティ ----------
  function fmtInt(n) {
    return Number(n).toLocaleString('ja-JP');
  }

  function fmtTime(ms) {
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} 秒`;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let val = bytes / 1024;
    let i = 0;
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i++;
    }
    return `${val.toFixed(1)} ${units[i]}`;
  }

  function sortedChildren(node) {
    return [...node.children.values()].sort((a, b) => b.count - a.count);
  }

  /**
   * スペース区切りの文字列でトライ木を辿り、該当ノードを探す。
   * 完全一致が無ければ大文字小文字を無視して一致を試みる。
   */
  function findNodeByPath(root, pathString) {
    const tokens = pathString.trim().split(/\s+/).filter(Boolean);
    let node = root;
    const resolvedPath = [];
    for (const token of tokens) {
      let child = node.children.get(token);
      if (!child) {
        const lower = token.toLowerCase();
        for (const [key, value] of node.children) {
          if (key.toLowerCase() === lower) {
            child = value;
            break;
          }
        }
      }
      if (!child) {
        return { node: null, resolvedPath, failedAt: node, failedToken: token };
      }
      node = child;
      resolvedPath.push(child.token);
    }
    return { node, resolvedPath, failedAt: null, failedToken: null };
  }

  function suggestSimilar(node, token) {
    if (!node) return [];
    const lower = token.toLowerCase();
    return [...node.children.entries()]
      .filter(([key]) => key.toLowerCase().startsWith(lower))
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8)
      .map(([key]) => key);
  }

  // ---------- ファイル選択 / ドラッグ&ドロップ ----------
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('is-dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-dragover');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  function handleFile(file) {
    resetForNewFile();
    dzFilename.hidden = false;
    dzFilename.textContent = `選択中: ${file.name}（${formatBytes(file.size)}）`;
    progressArea.hidden = false;
    setProgress('streaming', 0);

    if (currentWorker) currentWorker.terminate();
    currentWorker = new Worker('worker.js');
    currentWorker.onmessage = (e) => handleWorkerMessage(e.data);
    currentWorker.onerror = (err) => {
      showError(`ワーカーの実行中にエラーが発生しました: ${err.message}`);
      progressArea.hidden = true;
    };
    currentWorker.postMessage({ file });
  }

  function resetForNewFile() {
    errorBanner.hidden = true;
    panelMode.hidden = true;
    panelSummary.hidden = true;
    panelResult.hidden = true;
    resetResultArea();
    breadcrumbEl.hidden = true;
    queryInput.value = '';
    trieRoot = null;
  }

  function showError(msg) {
    errorBanner.hidden = false;
    errorBanner.textContent = msg;
  }

  function setProgress(phase, percent) {
    progressPhaseEl.textContent = phase === 'streaming' ? 'ストリーミング解析中...' : '処理中...';
    const p = Math.max(0, Math.min(100, percent));
    progressPercentEl.textContent = `${p.toFixed(0)}%`;
    progressBarEl.style.width = `${p}%`;
  }

  function handleWorkerMessage(data) {
    if (data.type === 'progress') {
      setProgress(data.phase, data.percent);
    } else if (data.type === 'done') {
      trieRoot = data.trie;
      onParseComplete(data.stats);
    } else if (data.type === 'error') {
      showError(`解析中にエラーが発生しました: ${data.message}`);
      progressArea.hidden = true;
    }
  }

  function onParseComplete(stats) {
    progressArea.hidden = true;
    panelMode.hidden = false;
    panelSummary.hidden = false;
    panelResult.hidden = false;

    statLines.textContent = fmtInt(stats.totalLines);
    statCommands.textContent = fmtInt(stats.matchedLines);
    statRoots.textContent = fmtInt(stats.uniqueRootCommands);
    statPlayers.textContent = fmtInt(stats.uniquePlayers);
    statTime.textContent = fmtTime(stats.elapsedMs);

    populateSuggestions(trieRoot);
    setMode(currentMode);
  }

  function populateSuggestions(root) {
    suggestionsList.innerHTML = '';
    const tokens = [...root.children.keys()].sort();
    for (const t of tokens) {
      const opt = document.createElement('option');
      opt.value = t;
      suggestionsList.appendChild(opt);
    }
  }

  // ---------- モード切り替え ----------
  const HELP_TEXT = {
    all: '全コマンドを使用率順のツリーで表示します。項目をクリックすると続きのトークン（引数）に展開できます。',
    continuation: '調べたいコマンドの先頭部分（例: /warp）を入力すると、その続きのトークンの使用率をツリーで表示します。',
    ranking: 'コマンドを入力すると、それを使用したプレイヤーを使用回数順にランキング表示します。空欄のまま調べると全コマンド合計でのランキングを表示します。',
  };

  modeTabs.forEach((tab) => {
    tab.addEventListener('click', () => setMode(tab.dataset.mode));
  });

  function setMode(mode) {
    currentMode = mode;
    modeTabs.forEach((t) => {
      const active = t.dataset.mode === mode;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    modeHelp.textContent = HELP_TEXT[mode];

    if (!trieRoot) return;

    if (mode === 'all') {
      queryForm.hidden = true;
      queryHint.textContent = '';
      renderTreeView(trieRoot, []);
    } else {
      queryForm.hidden = false;
      if (mode === 'continuation') {
        queryLabel.textContent = '続きを調べたいコマンドの先頭部分（スペース区切り）';
        queryInput.placeholder = '例: /warp　または　/tp home';
        queryHint.textContent = '空欄のまま調べると全コマンドのツリーを表示します。';
      } else {
        queryLabel.textContent = 'ランキングを見たいコマンド（空欄で全体ランキング）';
        queryInput.placeholder = '例: /home　または　/warp spawn';
        queryHint.textContent = '空欄のまま調べると全コマンド合計での利用者ランキングを表示します。';
      }
      if (queryInput.value.trim() !== '') {
        runQuery();
      } else {
        resetResultArea();
      }
    }
  }

  queryForm.addEventListener('submit', (e) => {
    e.preventDefault();
    runQuery();
  });

  function runQuery() {
    if (!trieRoot) return;
    const result = findNodeByPath(trieRoot, queryInput.value);
    if (!result.node) {
      renderNotFound(result);
      return;
    }
    if (currentMode === 'continuation') {
      renderTreeView(result.node, result.resolvedPath);
    } else if (currentMode === 'ranking') {
      renderRankingView(result.node, result.resolvedPath);
    }
  }

  // ---------- 結果表示: 共通 ----------
  function resetResultArea() {
    resultMessage.hidden = true;
    resultMessage.classList.remove('is-empty');
    resultMessage.textContent = '';
    resultTree.hidden = true;
    resultTree.innerHTML = '';
    resultRanking.hidden = true;
    resultRanking.innerHTML = '';
  }

  function updateBreadcrumb(path) {
    breadcrumbEl.innerHTML = '';
    if (path.length === 0) {
      breadcrumbEl.hidden = true;
      return;
    }
    breadcrumbEl.hidden = false;
    const rootSpan = document.createElement('span');
    rootSpan.className = 'crumb';
    rootSpan.textContent = '全コマンド';
    breadcrumbEl.appendChild(rootSpan);
    path.forEach((tok) => {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '›';
      breadcrumbEl.appendChild(sep);
      const span = document.createElement('span');
      span.className = 'crumb';
      span.textContent = tok;
      breadcrumbEl.appendChild(span);
    });
  }

  function renderNotFound({ failedAt, failedToken }) {
    resetResultArea();
    resultMessage.hidden = false;
    resultMessage.classList.add('is-empty');

    const p1 = document.createElement('p');
    p1.textContent = `「${failedToken}」に一致するコマンドが見つかりませんでした。`;
    resultMessage.appendChild(p1);

    const suggestions = suggestSimilar(failedAt, failedToken);
    if (suggestions.length > 0) {
      const p2 = document.createElement('p');
      p2.appendChild(document.createTextNode('もしかして: '));
      suggestions.forEach((s) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'suggest-btn';
        btn.textContent = s;
        btn.style.marginRight = '12px';
        btn.addEventListener('click', () => {
          queryInput.value = s;
          runQuery();
        });
        p2.appendChild(btn);
      });
      resultMessage.appendChild(p2);
    }
  }

  // ---------- 結果表示: ツリー ----------
  function renderTreeView(node, path) {
    resetResultArea();
    updateBreadcrumb(path);

    const children = sortedChildren(node);
    if (children.length === 0) {
      resultMessage.hidden = false;
      resultMessage.classList.add('is-empty');
      resultMessage.textContent = 'この階層には続きのトークンがありません（末端のコマンドです）。';
      return;
    }

    resultTree.hidden = false;
    const ul = document.createElement('ul');
    ul.className = 'tree-root';
    resultTree.appendChild(ul);
    appendChildrenBatch(ul, children, node.count, 0, 100, true);
  }

  function appendChildrenBatch(container, children, parentTotal, startIndex, batchSize, isRoot) {
    const end = Math.min(startIndex + batchSize, children.length);
    for (let i = startIndex; i < end; i++) {
      container.appendChild(createTreeNodeElement(children[i], parentTotal, isRoot));
    }
    if (end < children.length) {
      const li = document.createElement('li');
      li.className = 'load-more';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = `さらに表示（残り ${fmtInt(children.length - end)} 件）`;
      btn.addEventListener('click', () => {
        li.remove();
        appendChildrenBatch(container, children, parentTotal, end, batchSize, isRoot);
      });
      li.appendChild(btn);
      container.appendChild(li);
    }
  }

  function createTreeNodeElement(node, parentTotal, isRoot) {
    const li = document.createElement('li');
    li.className = 'tree-node';

    const row = document.createElement('div');
    row.className = 'tree-row';

    const toggle = document.createElement('span');
    toggle.className = 'toggle';
    const hasChildren = node.children.size > 0;
    toggle.textContent = hasChildren ? '▶' : '·';

    const label = document.createElement('span');
    label.className = 'label' + (isRoot ? ' is-root-command' : '');
    label.textContent = node.token;
    label.title = node.token;

    const stats = document.createElement('span');
    stats.className = 'stats';
    const rate = parentTotal > 0 ? (node.count / parentTotal) * 100 : 0;

    const bar = document.createElement('span');
    bar.className = 'rate-bar';
    const barFill = document.createElement('span');
    barFill.style.width = `${Math.max(rate, 1.5)}%`;
    bar.appendChild(barFill);

    const rateEl = document.createElement('span');
    rateEl.className = 'rate';
    rateEl.textContent = `${rate.toFixed(2)}%`;

    const countEl = document.createElement('span');
    countEl.className = 'count';
    countEl.textContent = `${fmtInt(node.count)} 回`;

    stats.appendChild(bar);
    stats.appendChild(rateEl);
    stats.appendChild(countEl);

    row.appendChild(toggle);
    row.appendChild(label);
    row.appendChild(stats);
    li.appendChild(row);

    if (hasChildren) {
      row.classList.add('is-expandable');
      const childUl = document.createElement('ul');
      childUl.className = 'tree-children hidden';
      li.appendChild(childUl);

      let expanded = false;
      let built = false;

      row.addEventListener('click', () => {
        expanded = !expanded;
        row.classList.toggle('is-open', expanded);
        toggle.textContent = expanded ? '▼' : '▶';
        if (expanded && !built) {
          appendChildrenBatch(childUl, sortedChildren(node), node.count, 0, 100, false);
          built = true;
        }
        childUl.classList.toggle('hidden', !expanded);
      });
    }

    return li;
  }

  // ---------- 結果表示: ランキング ----------
  function renderRankingView(node, path) {
    resetResultArea();
    updateBreadcrumb(path);

    const entries = [...node.players.entries()].sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      resultMessage.hidden = false;
      resultMessage.classList.add('is-empty');
      resultMessage.textContent = 'このコマンドを使用したプレイヤーが見つかりませんでした。';
      return;
    }

    resultRanking.hidden = false;
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['#', 'プレイヤー', '使用回数', '使用率'].forEach((text, i) => {
      const th = document.createElement('th');
      th.textContent = text;
      if (i >= 2) th.className = 'num';
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    resultRanking.appendChild(table);

    appendRankingBatch(tbody, entries, node.count, 0, 50);
  }

  function appendRankingBatch(tbody, entries, total, startIndex, batchSize) {
    const end = Math.min(startIndex + batchSize, entries.length);
    for (let i = startIndex; i < end; i++) {
      const [player, count] = entries[i];
      const rate = total > 0 ? (count / total) * 100 : 0;

      const tr = document.createElement('tr');

      const rankTd = document.createElement('td');
      rankTd.className = 'rank' + (i < 3 ? ' top' : '');
      rankTd.textContent = String(i + 1);

      const nameTd = document.createElement('td');
      nameTd.className = 'player-name';
      nameTd.textContent = player;

      const countTd = document.createElement('td');
      countTd.className = 'num';
      countTd.textContent = `${fmtInt(count)} 回`;

      const rateTd = document.createElement('td');
      rateTd.className = 'num rate-cell';
      rateTd.textContent = `${rate.toFixed(2)}%`;

      tr.appendChild(rankTd);
      tr.appendChild(nameTd);
      tr.appendChild(countTd);
      tr.appendChild(rateTd);
      tbody.appendChild(tr);
    }

    if (end < entries.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'load-more';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = `さらに表示（残り ${fmtInt(entries.length - end)} 人）`;
      btn.addEventListener('click', () => {
        tr.remove();
        appendRankingBatch(tbody, entries, total, end, batchSize);
      });
      td.appendChild(btn);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
  }
})();
