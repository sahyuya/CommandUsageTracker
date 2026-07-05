/*
 * worker.js
 * Minecraftサーバーのコンソールログ（テキスト）を解析し、
 * "issued server command:" を目印にプレイヤー名とコマンドを抽出、
 * コマンドをスペース区切りでトークン化してトライ木(Trie)に集計する。
 *
 * メインスレッドをブロックしないよう、Web Worker上で実行する。
 * 進捗は { type: 'progress', phase: 'loading' | 'aggregating', percent } で通知し、
 * 完了時は { type: 'done', trie, stats } を送る。
 */

const MARKER = 'issued server command:';
// ANSIエスケープシーケンス（色付きログ対策）
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function createNode(token) {
  return {
    token,
    count: 0,
    children: new Map(),
    players: new Map(),
  };
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

/**
 * 1行を解析してプレイヤー名とコマンド文字列を取り出す。
 * 見つからない場合は null を返す。
 */
function extractPlayerAndCommand(rawLine) {
  const idx = rawLine.indexOf(MARKER);
  if (idx === -1) return null;

  const line = rawLine.indexOf('\x1b') !== -1 ? rawLine.replace(ANSI_RE, '') : rawLine;
  const idx2 = line.indexOf(MARKER);
  if (idx2 === -1) return null;

  // "]" (ログのタグ終端) の直後からマーカーまでをプレイヤー名とみなす
  const bracketIdx = line.lastIndexOf(']', idx2);
  let namePart = bracketIdx === -1 ? line.slice(0, idx2) : line.slice(bracketIdx + 1, idx2);
  namePart = namePart.replace(/^:/, '').trim();

  let command = line.slice(idx2 + MARKER.length).trim();
  if (!command) return null;

  return {
    player: namePart || '(不明なプレイヤー)',
    command,
  };
}

function insertIntoTrie(root, tokens, player) {
  let node = root;
  node.count++;
  bump(node.players, player);
  for (const token of tokens) {
    let child = node.children.get(token);
    if (!child) {
      child = createNode(token);
      node.children.set(token, child);
    }
    node = child;
    node.count++;
    bump(node.players, player);
  }
}

function processLine(rawLine, root) {
  const parsed = extractPlayerAndCommand(rawLine);
  if (!parsed) return false;
  const tokens = parsed.command.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  insertIntoTrie(root, tokens, parsed.player);
  return true;
}

function readFileWithProgress(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (evt) => {
      if (evt.lengthComputable) {
        const percent = (evt.loaded / evt.total) * 100;
        postMessage({ type: 'progress', phase: 'loading', percent });
      }
    };
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('ファイルの読み込みに失敗しました'));
    reader.readAsText(file, 'utf-8');
  });
}

function buildTrie(text) {
  const root = createNode(null);
  const lines = text.split(/\r\n|\r|\n/);
  const totalLines = lines.length;
  let matchedLines = 0;
  let lastReportedPercent = -1;
  const reportEvery = Math.max(1, Math.floor(totalLines / 200)); // 約0.5%刻み

  for (let i = 0; i < totalLines; i++) {
    if (processLine(lines[i], root)) matchedLines++;

    if (i % reportEvery === 0 || i === totalLines - 1) {
      const percent = ((i + 1) / totalLines) * 100;
      const rounded = Math.floor(percent * 10) / 10;
      if (rounded !== lastReportedPercent) {
        lastReportedPercent = rounded;
        postMessage({ type: 'progress', phase: 'aggregating', percent });
      }
    }
  }

  return { root, totalLines, matchedLines };
}

function countUniquePlayers(root) {
  return root.players.size;
}

// Node.js等でユニットテストする際に内部関数を参照できるようにする（ブラウザ上では無害）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractPlayerAndCommand, insertIntoTrie, buildTrie, createNode };
}

if (typeof self !== 'undefined') {
self.onmessage = async function (e) {
  const { file } = e.data;
  try {
    postMessage({ type: 'progress', phase: 'loading', percent: 0 });
    const text = await readFileWithProgress(file);

    postMessage({ type: 'progress', phase: 'aggregating', percent: 0 });
    const startedAt = performance.now();
    const { root, totalLines, matchedLines } = buildTrie(text);
    const elapsedMs = performance.now() - startedAt;

    const stats = {
      totalLines,
      matchedLines,
      uniqueRootCommands: root.children.size,
      uniquePlayers: countUniquePlayers(root),
      elapsedMs,
    };

    postMessage({ type: 'done', trie: root, stats });
  } catch (err) {
    postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
}
