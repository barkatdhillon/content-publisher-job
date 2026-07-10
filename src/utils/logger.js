function serializeError(error) {
  if (!error) return undefined;
  if (error.response && error.response.data !== undefined) {
    return { status: error.response.status, data: error.response.data };
  }
  if (error.stack) return error.stack;
  return error.message || String(error);
}

function createLogger(moduleName) {
  const prefix = `[${moduleName}]`;

  return {
    info: (message, context) => {
      console.log(prefix, message, context ? JSON.stringify(context) : '');
    },
    warn: (message, context) => {
      console.warn(prefix, message, context ? JSON.stringify(context) : '');
    },
    error: (message, context, error) => {
      console.error(prefix, message, context ? JSON.stringify(context) : '', serializeError(error) ?? '');
    }
  };
}

module.exports = { createLogger };
