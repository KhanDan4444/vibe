/**
 * Zod request validation middleware.
 */
function formatZodError(error) {
  return error.errors
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message}`;
    })
    .join('; ');
}

function firstZodField(error) {
  const issue = error.errors[0];
  if (!issue?.path?.length) return undefined;
  return issue.path.join('.');
}

function validationErrorResponse(error) {
  const field = firstZodField(error);
  const body = { error: formatZodError(error) };
  if (field) body.field = field;
  return body;
}

function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json(validationErrorResponse(result.error));
    }
    req.body = result.data;
    next();
  };
}

function validateParams(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      return res.status(400).json(validationErrorResponse(result.error));
    }
    req.params = result.data;
    next();
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return res.status(400).json(validationErrorResponse(result.error));
    }
    req.query = { ...req.query, ...result.data };
    next();
  };
}

module.exports = {
  validateBody,
  validateParams,
  validateQuery,
};
