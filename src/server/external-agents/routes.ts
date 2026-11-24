import { grokReplyPath, grokRoutineInstructions } from './grok-routine.ts';
import type { Express } from 'express';
import { z } from 'zod';
import { externalAgentIds } from '../../shared/external-agents.ts';
import type { ExternalAgents } from './service.ts';

const agentId = z.enum(externalAgentIds);
const messageId = z.string().uuid();

export function externalAgentRoutes(app: Express, agents: ExternalAgents, listeningPort: () => number = () => 0) {
  app.post(grokReplyPath, (req, res) => {
    const body = z
      .object({
        replyId: z.string().regex(/^[a-f0-9]{32}$/),
        text: z.string().min(1),
        more: z.boolean().optional(),
        part: z.number().int().min(1).max(1000).optional(),
      })
      .strict()
      .safeParse(req.body);
    const status = body.success
      ? agents.receiveGrokReply(body.data.replyId, body.data.text, body.data.more, body.data.part)
      : 404;
    res
      .status(status)
      .json(status === 200 ? { ok: true } : { error: status === 413 ? 'Reply too large' : 'Not found' });
  });
  app.put('/api/external-agents/grok-bot/routine', async (req, res) => {
    const body = z
      .object({ url: z.string().max(2000), key: z.string().max(4096).optional() })
      .strict()
      .parse(req.body);
    await agents.routineStore.save(body.url, body.key);
    agents.update('grok-bot', { added: true });
    res.json({ agents: agents.list() });
  });
  app.get('/api/external-agents/grok-bot/routine-instructions', (_req, res) => {
    res.json({ text: grokRoutineInstructions(listeningPort()) });
  });
  app.get('/api/external-agents', (_req, res) => {
    res.json({ agents: agents.list() });
  });
  app.patch('/api/external-agents/:id', (req, res) => {
    const patch = z
      .object({
        added: z.literal(true).optional(),
        enabled: z.boolean().optional(),
        botId: z.string().max(200).optional(),
        usageEnabled: z.boolean().optional(),
        usageSource: z.enum(['separate', 'cursor-editor']).optional(),
        usageAccountConfirmed: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        acceptRisk: z.literal(true).optional(),
        url: z.string().max(2000).optional(),
        usageUrl: z.string().max(2000).optional(),
      })
      .strict()
      .parse(req.body);
    agents.update(agentId.parse(req.params.id), patch);
    res.json({ agents: agents.list() });
  });
  app.post('/api/external-agents/:id/login', async (req, res) => {
    res.json(await agents.login(agentId.parse(req.params.id)));
  });
  app.post('/api/external-agents/:id/open', async (req, res) => {
    res.json(await agents.openDesktop(agentId.parse(req.params.id)));
  });
  app.post('/api/external-agents/:id/usage-settings', async (req, res) => {
    res.json(await agents.openDesktop(agentId.parse(req.params.id), true));
  });
  app.post('/api/external-agents/:id/detect', async (req, res) => {
    const result = await agents.detect(agentId.parse(req.params.id));
    res.json({ ok: result.ok, message: result.message, agents: agents.list() });
  });
  app.post('/api/external-agents/:id/usage', async (req, res) => {
    const result = await agents.readUsage(agentId.parse(req.params.id));
    res.json({ ok: result.ok, message: result.message, agents: agents.list() });
  });
  app.post('/api/external-agents/messages/:messageId/retry', (req, res) => {
    agents.retry(messageId.parse(req.params.messageId));
    res.json({ ok: true });
  });
  app.post('/api/external-agents/messages/:messageId/stop-following', (req, res) => {
    agents.stopFollowing(messageId.parse(req.params.messageId));
    res.json({ ok: true });
  });
  app.post('/api/external-agents/messages/:messageId/import-reply', (req, res) => {
    const body = z
      .object({ text: z.string().max(200_000) })
      .strict()
      .parse(req.body);
    agents.importReply(messageId.parse(req.params.messageId), body.text);
    res.json({ ok: true });
  });
  app.post('/api/external-agents/messages/:messageId/handoff', async (req, res) => {
    await agents.handoff(messageId.parse(req.params.messageId));
    res.json({ ok: true });
  });
}
