export function writeMessage(message: any) {
  return new Promise<void>((resolve, reject) => {
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

export function success(id: any, result: any) {
  return writeMessage({
    jsonrpc: '2.0',
    id,
    result
  });
}

export function failure(id: any, code: any, message: any, data = undefined) {
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

export function createMessageParser(onMessage: any) {
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
    push(chunk: any) {
      buffer = Buffer.concat([buffer, chunk]);
      processBuffer();
      return queue;
    }
  };
}

export async function runMcpServer(parseArgs: (argv: string[]) => Record<string, any>, handleRequest: (message: any, defaults: any) => Promise<void>): Promise<void> {
  const defaults = parseArgs(process.argv.slice(2));
  const parser = createMessageParser((message: any) => handleRequest(message, defaults));
  let lastQueue = Promise.resolve();

  process.stdin.on('data', (chunk) => {
    lastQueue = parser.push(chunk);
  });
  process.stdin.resume();

  await new Promise<void>((resolve) => {
    process.stdin.on('end', () => resolve());
  });
  await lastQueue;
}


