const express = require('express');
const {
  requireJwtAuth,
  requireSameOrigin,
  messageUserLimiter,
  strictConfigMiddleware,
} = require('~/server/middleware');
const filesystem = require('~/server/services/Filesystem');

const router = express.Router();
const handlers = filesystem.router();
router.use(requireJwtAuth, requireSameOrigin, strictConfigMiddleware);
router.post('/sessions', messageUserLimiter, handlers.create);
router.post('/sessions/:id/heartbeat', handlers.heartbeat);
router.post('/sessions/:id/results/:requestId', handlers.result);
router.delete('/sessions/:id', handlers.remove);
module.exports = router;
