/*
 * worker.js
 * MinecraftサーバーのコンソールログやCSVを解析し、
 * トライ木(Trie)にコマンド利用統計を集計する。
 *
 * File.stream() を用いたストリーミング処理により、
 * 巨大なファイルでもメモリを圧迫せずに随時集計を行う。
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

// 簡易的なCSV行パーサー（クォート内のカンマに対応）
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i+1] === '"') {
        current += '"'; // エスケープされたクォート
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

self.onmessage = async function (e) {
  const { file } = e.data;
  const root = createNode(null);
  let totalLines = 0;
  let matchedLines = 0;

  const isCsv = file.name.toLowerCase().endsWith('.csv');
  let csvHeaders = null;
  let playerIdx = -1;
  let commandIdx = -1;

  // 従来のテキストログ形式のパース
  function extractFromTextLog(rawLine) {
    const idx = rawLine.indexOf(MARKER);
    if (idx === -1) return null;

    const line = rawLine.indexOf('\x1b') !== -1 ? rawLine.replace(ANSI_RE, '') : rawLine;
    const idx2 = line.indexOf(MARKER);
    if (idx2 === -1) return null;

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

  // 総合的な行パース（CSV対応）
  function extractPlayerAndCommand(rawLine) {
    if (isCsv) {
      const cols = parseCSVLine(rawLine);
      if (cols.length === 0) return null;

      // ヘッダー行の判定とカラムインデックスの特定
      if (!csvHeaders) {
        csvHeaders = cols.map(h => h.trim().toLowerCase());
        playerIdx = csvHeaders.findIndex(h => ['player', 'user', 'name', 'uuid'].includes(h));
        commandIdx = csvHeaders.findIndex(h => ['command', 'message', 'cmd', 'action', 'content'].includes(h));
        
        // ヘッダーっぽくない（既にコマンドが入っている）場合はデータとして処理
        const hasCommandLike = csvHeaders.some(h => h.startsWith('/'));
        if (hasCommandLike) {
            csvHeaders = []; 
        } else {
            return null; // ヘッダー行をスキップ
        }
      }
      
      let player = '';
      let command = '';
      
      if (playerIdx !== -1 && commandIdx !== -1 && cols.length > Math.max(playerIdx, commandIdx)) {
        player = cols[playerIdx];
        command = cols[commandIdx];
      } else {
        // カラム名が不明な場合はヒューリスティックに探す
        for (let i = 0; i < cols.length; i++) {
          const val = cols[i].trim();
          if (val.startsWith('/')) {
            command = val;
            player = i > 0 ? cols[i-1].trim() : '(不明なプレイヤー)';
            break;
          }
        }
      }

      // ログの内容がそのまま1カラムに押し込まれているケースへのフォールバック
      if (!command) {
        for (const col of cols) {
          const text = col.trim();
          if (text.indexOf(MARKER) !== -1) {
            return extractFromTextLog(text);
          }
        }
      }

      if (!command) return null;
      return { player: player || '(不明なプレイヤー)', command };
    } else {
      return extractFromTextLog(rawLine);
    }
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

  try {
    let stream;
    if (file.stream) {
      stream = file.stream();
    } else {
      throw new Error('お使いのブラウザは大容量ファイルのストリーミング読み込みに対応していません。最新のChrome, Edge, Firefox等をご利用ください。');
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    
    let partialLine = '';
    let bytesRead = 0;
    const totalBytes = file.size;
    const startedAt = performance.now();
    let lastReportedPercent = -1;

    // ストリーミングでチャンクごとに読み込み・解析を行う
    while (true) {
      const { done, value } = await reader.read();
      
      if (value) {
        bytesRead += value.byteLength;
        const percent = Math.floor((bytesRead / (totalBytes || 1)) * 100);
        if (percent !== lastReportedPercent) {
           postMessage({ type: 'progress', phase: 'streaming', percent });
           lastReportedPercent = percent;
        }

        const textChunk = partialLine + decoder.decode(value, { stream: !done });
        const lines = textChunk.split(/\r\n|\r|\n/);
        
        partialLine = lines.pop(); // 最後の要素は行が途切れている可能性があるので保持

        for (const line of lines) {
          if (!line) continue;
          totalLines++;
          const parsed = extractPlayerAndCommand(line);
          if (parsed) {
            const tokens = parsed.command.split(/\s+/).filter(Boolean);
            if (tokens.length > 0) {
               insertIntoTrie(root, tokens, parsed.player);
               matchedLines++;
            }
          }
        }
      }
      
      if (done) {
        // 最後に残ったテキストの処理
        const finalStr = partialLine + decoder.decode();
        const lines = finalStr.split(/\r\n|\r|\n/);
        for (const line of lines) {
          if (!line) continue;
          totalLines++;
          const parsed = extractPlayerAndCommand(line);
          if (parsed) {
            const tokens = parsed.command.split(/\s+/).filter(Boolean);
            if (tokens.length > 0) {
               insertIntoTrie(root, tokens, parsed.player);
               matchedLines++;
            }
          }
        }
        break;
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

    postMessage({ type: 'done', trie: root, stats });
  } catch (err) {
    postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
