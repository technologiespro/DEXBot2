#!/usr/bin/env node

// MCP stdio reserves stdout for JSON-RPC frames. Some shared DEXBot2 modules
// log during require-time initialization, so suppress incidental console logs.
console.log = () => {};
console.warn = () => {};

const { getClawToolByName, getClawToolCatalog } = require('../modules/claw_catalog');
const { runClawCommand } = require('../modules/claw_bridge');

function parseArgs(argv) {
  const options = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--profile-root' && next) {
      options.profileRoot = next;
      i += 1;
      continue;
    }

    if (arg === '--account' && next) {
      options.accountName = next;
      i += 1;
      continue;
    }

    if (arg === '--runtime' && next) {
      options.runtimeName = next;
      i += 1;
      continue;
    }
  }

  return options;
}

function writeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      process.stdout.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function success(id, result) {
  return writeMessage({
    jsonrpc: '2.0',
    id,
    result
  });
}

function failure(id, code, message, data = undefined) {
  return writeMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  });
}

function listMcpTools() {
  return getClawToolCatalog().map((tool) => ({
    name: tool.toolName,
    description: tool.description,
    inputSchema: tool.inputSchema || {
      type: 'object',
      properties: {},
      additionalProperties: true
    }
  }));
}

async function handleRequest(message, defaults) {
  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      return success(id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {
            listChanged: false
          }
        },
        serverInfo: {
          name: 'bitshares-claw',
          version: '0.1.0'
        }
      });

    case 'notifications/initialized':
      return;

    case 'ping':
      return success(id, {});

    case 'tools/list':
      return success(id, {
        tools: listMcpTools()
      });

    case 'tools/call': {
      const tool = getClawToolByName(params?.name);
      if (!tool) {
        return failure(id, -32602, `Unknown tool: ${params?.name || '(missing)'}`);
      }

      try {
        const result = await runClawCommand(tool.command, {
          ...defaults,
          ...(params?.arguments || {})
        });

        return success(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ],
          structuredContent: result
        });
      } catch (error) {
        return success(id, {
          content: [
            {
              type: 'text',
              text: error && error.stack ? error.stack : String(error)
            }
          ],
          isError: true
        });
      }
    }

    default:
      if (id !== undefined) {
        return failure(id, -32601, `Method not found: ${method}`);
      }
  }
}

function createMessageParser(onMessage) {
  let buffer = Buffer.alloc(0);
  let queue = Promise.resolve();

  function processBuffer() {
    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex).toString('utf8').trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        continue;
      }

      queue = queue.then(() => onMessage(message)).catch((error) => {
        process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
      });
    }
  }

  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      processBuffer();
      return queue;
    }
  };
}

async function main() {
  const defaults = parseArgs(process.argv.slice(2));
  const parser = createMessageParser((message) => handleRequest(message, defaults));
  let lastQueue = Promise.resolve();

  process.stdin.on('data', (chunk) => {
    lastQueue = parser.push(chunk);
  });
  process.stdin.resume();

  await new Promise((resolve) => {
    process.stdin.on('end', resolve);
  });
  await lastQueue;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}

export = {
  createMessageParser,
  failure,
  handleRequest,
  listMcpTools,
  main,
  success,
  writeMessage
};
