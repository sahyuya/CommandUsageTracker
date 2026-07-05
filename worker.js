/*
 * worker.js
 * MinecraftサーバーのコンソールログやCSVを解析し、
 * トライ木(Trie)にコマンド利用統計を集計する。
 *
 * File.stream() を用いたストリーミング処理により、
 * 巨大なファイルでもメモリを圧迫せずに随時集計を行う。
 */

const MARKER = 'issued server command:';
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function createNode(token) {
  return {
    token,
    count: 0,
    children: new Map(),
    players: new Map(),
    // UI側の除外状態管理用
    excluded: false, 
    excludedPlayers: new Set()
  };
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

// CSV形式からのプレイヤー名とコマンド抽出
function extractFromCSV(line) {
  const regex = /,(?=(?:(?:[^"]*"){2})*[^"]*$)/;
  const cols = line.split(regex).map(s => s.replace(/^"|"$/g, '').trim());
  if (cols.length < 2) return null;

  let player = null;
  let command = null;

  for (let i = 0; i < cols.length; i++) {
    const col = cols[i];
    if (col.startsWith('/')) {
      command = col;
      if (i > 0 && cols[i-1] && !cols[i-1].includes(' ')) {
        player = cols[i-1];
      } else {
        player = cols[0];
      }
      break;
    }
  }

  if (command && player) {
    return { player, command };
  }
  return null;
}

function extractPlayerAndCommand(rawLine) {
  const idx = rawLine.indexOf(MARKER);
  if (idx !== -1) {
    const line = rawLine.indexOf('\x1b') !== -1 ? rawLine.replace(ANSI_RE, '') : rawLine;
    const idx2 = line.indexOf(MARKER);
    const bracketIdx = line.lastIndexOf(']', idx2);
    let namePart = bracketIdx === -1 ? line.slice(0, idx2) : line.slice(bracketIdx + 1, idx2);
    namePart = namePart.replace(/^:/, '').trim();
    let command = line.slice(idx2 + MARKER.length).trim();
    if (command) {
      return { player: namePart || '(不明なプレイヤー)', command };
    }
  } else if (rawLine.includes(',')) {
    return extractFromCSV(rawLine);
  }
  return null;
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

self.onmessage = async function (e) {
  const { file } = e.data;
  try {
    const startedAt = performance.now();
    const root = createNode(null);
    let totalLines = 0;
    let matchedLines = 0;

    const fileSize = file.size;
    let processedBytes = 0;
    let lastReportedPercent = -1;

    postMessage({ type: 'progress', phase: 'processing', percent: 0 });

    const stream = file.stream();
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      processedBytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop();

      for (const line of lines) {
        totalLines++;
        if (processLine(line, root)) {
          matchedLines++;
        }
      }

      const percent = fileSize > 0 ? (processedBytes / fileSize) * 100 : 100;
      const rounded = Math.floor(percent * 10) / 10;
      if (rounded !== lastReportedPercent) {
        lastReportedPercent = rounded;
        postMessage({ type: 'progress', phase: 'processing', percent: rounded });
      }
    }

    buffer += decoder.decode();
    if (buffer) {
      const lines = buffer.split(/\r\n|\r|\n/);
      for (const line of lines) {
        if (line.trim() === '') continue;
        totalLines++;
        if (processLine(line, root)) {
          matchedLines++;
        }
      }
    }

    const elapsedMs = performance.now() - startedAt;
    const stats = {
      totalLines,
      matchedLines,
      uniqueRootCommands: root.children.size,
      uniquePlayers: root.players.size,
      elapsedMs,
    };

    postMessage({ type: 'progress', phase: 'processing', percent: 100 });
    postMessage({ type: 'done', trie: root, stats });

  } catch (err) {
    postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};