import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), 'backend/.env') });

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.E2E_AUTH_BYPASS = 'true';
process.env.MOCK_LLM = 'false';

import request from 'supertest';
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';
import app from '../app';
import { prisma } from '../lib/prisma';

const TEST_TOPIC_PREFIX = '[mwf-moment-eval]';
const STAGE1_MOMENT_ID = 'stage-1-fact-reflection';
const HAIKU_MODEL_ID = process.env.BEDROCK_HAIKU_MODEL_ID || 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

type SeedResult = {
  sessionId: string;
  actorUserId: string;
  partnerUserId: string;
  actorEmail: string;
  rows: Record<string, number>;
  messages: Array<{ id: string; role: string; content: string; stage: number }>;
  stageProgress: Array<{ userId: string; stage: number; status: string; gatesSatisfied: unknown }>;
};

type MomentParticipant = {
  role: string;
  name: string;
  compactSigned?: boolean;
  stageGates?: Record<string, unknown>;
};

type MomentProposal = {
  id: string;
  kind: string;
  owner?: string;
  description: string;
  selectedBy?: Record<string, string>;
};

type MomentPayload = {
  id: string;
  stages: number[];
  seed: {
    session?: Record<string, unknown>;
    participants: MomentParticipant[];
    prior_history_summary?: string[];
    proposals?: MomentProposal[];
  };
  trigger?: {
    actor?: string;
    body?: { content?: string };
  };
};

function requireEnv(names: string[]): void {
  const missing = names.filter(name => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }
}

async function seedStage1FactReflection(): Promise<SeedResult> {
  requireEnv(['DATABASE_URL']);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const actorEmail = `moment-stage1-adam-${suffix}@example.test`;
  const partnerEmail = `moment-stage1-eve-${suffix}@example.test`;

  const result = await prisma.$transaction(async tx => {
    const [actor, partner] = await Promise.all([
      tx.user.create({
        data: {
          email: actorEmail,
          clerkId: `e2e_moment-stage1-adam-${suffix}`,
          name: 'Adam',
          firstName: 'Adam',
        },
      }),
      tx.user.create({
        data: {
          email: partnerEmail,
          clerkId: `e2e_moment-stage1-eve-${suffix}`,
          name: 'Eve',
          firstName: 'Eve',
        },
      }),
    ]);

    const relationship = await tx.relationship.create({
      data: {
        members: {
          create: [
            { userId: actor.id, role: 'invitor', nickname: 'Eve' },
            { userId: partner.id, role: 'invitee', nickname: 'Adam' },
          ],
        },
      },
    });

    const session = await tx.session.create({
      data: {
        relationshipId: relationship.id,
        status: 'ACTIVE',
        topicFrame: `${TEST_TOPIC_PREFIX} ${STAGE1_MOMENT_ID}`,
      },
    });

    const [actorVessel, partnerVessel] = await Promise.all([
      tx.userVessel.create({
        data: {
          userId: actor.id,
          sessionId: session.id,
          notableFacts: [
            { category: 'Conflict', fact: 'Adam feels Eve keeps pushing for more experiences and change.' },
            { category: 'Emotion', fact: 'Adam is scared Eve may leave because he cannot give her enough.' },
            {
              category: 'Pattern',
              fact: 'When Eve raises travel or growth, Adam gets quiet and then feels he made things worse.',
            },
          ],
        },
      }),
      tx.userVessel.create({
        data: {
          userId: partner.id,
          sessionId: session.id,
          notableFacts: [
            { category: 'Conflict', fact: 'Eve wants more travel, growth, and aliveness in the relationship.' },
          ],
        },
      }),
    ]);

    await tx.emotionalReading.create({
      data: {
        vesselId: actorVessel.id,
        intensity: 7,
        stage: 1,
        context: 'Steady pressure, not a spike.',
      },
    });
    await tx.emotionalReading.create({
      data: {
        vesselId: partnerVessel.id,
        intensity: 6,
        stage: 1,
        context: 'Seeded partner baseline for completeness.',
      },
    });

    await tx.stageProgress.createMany({
      data: [
        {
          sessionId: session.id,
          userId: actor.id,
          stage: 0,
          status: 'COMPLETED',
          completedAt: new Date(),
          gatesSatisfied: { compactSigned: true, signedAt: new Date().toISOString() },
        },
        {
          sessionId: session.id,
          userId: partner.id,
          stage: 0,
          status: 'COMPLETED',
          completedAt: new Date(),
          gatesSatisfied: { compactSigned: true, signedAt: new Date().toISOString() },
        },
        {
          sessionId: session.id,
          userId: actor.id,
          stage: 1,
          status: 'IN_PROGRESS',
          gatesSatisfied: { feelHeardConfirmed: false },
        },
        {
          sessionId: session.id,
          userId: partner.id,
          stage: 1,
          status: 'IN_PROGRESS',
          gatesSatisfied: { feelHeardConfirmed: false },
        },
      ],
    });

    const history = await Promise.all([
      tx.message.create({
        data: {
          sessionId: session.id,
          senderId: actor.id,
          role: 'USER',
          stage: 1,
          content:
            "I don't even know where to begin. We have a good life, but it feels like none of that matters to her.",
        },
      }),
      tx.message.create({
        data: {
          sessionId: session.id,
          forUserId: actor.id,
          role: 'AI',
          stage: 1,
          content: "You've built something that feels solid to you, and you're not experiencing it as appreciated.",
        },
      }),
      tx.message.create({
        data: {
          sessionId: session.id,
          senderId: actor.id,
          role: 'USER',
          stage: 1,
          content: 'She brings up travel and new experiences, and every time I hear that, something in me contracts.',
        },
      }),
      tx.message.create({
        data: {
          sessionId: session.id,
          forUserId: actor.id,
          role: 'AI',
          stage: 1,
          content:
            'There is a loop here: she raises something, you pull back, she gets frustrated, and then you carry the weight of that too.',
        },
      }),
      tx.message.create({
        data: {
          sessionId: session.id,
          senderId: actor.id,
          role: 'USER',
          stage: 1,
          content: "I love her, but I'm constantly bracing, like the next thing she says will confirm I'm not enough.",
        },
      }),
    ]);

    const stageProgress = await tx.stageProgress.findMany({
      where: { sessionId: session.id },
      orderBy: [{ userId: 'asc' }, { stage: 'asc' }],
    });

    return {
      sessionId: session.id,
      actorUserId: actor.id,
      partnerUserId: partner.id,
      actorEmail,
      rows: {
        Session: 1,
        Relationship: 1,
        RelationshipMember: 2,
        User: 2,
        UserVessel: 2,
        StageProgress: stageProgress.length,
        Message: history.length,
      },
      messages: history.map(message => ({
        id: message.id,
        role: message.role,
        content: message.content,
        stage: message.stage,
      })),
      stageProgress: stageProgress.map(progress => ({
        userId: progress.userId,
        stage: progress.stage,
        status: progress.status,
        gatesSatisfied: progress.gatesSatisfied,
      })),
    };
  });

  return result;
}

async function seedGenericMoment(moment: MomentPayload): Promise<SeedResult> {
  requireEnv(['DATABASE_URL']);
  const currentStage = Math.max(...moment.stages.filter(stage => stage <= 4));
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const participants = moment.seed.participants.slice(0, 2);
  if (participants.length < 2) {
    throw new Error(`Moment ${moment.id} must include at least two participants`);
  }
  const actorName = moment.trigger?.actor || participants[0].name;

  const result = await prisma.$transaction(async tx => {
    const users = await Promise.all(
      participants.map((participant, index) =>
        tx.user.create({
          data: {
            email: `moment-${moment.id}-${participant.name.toLowerCase()}-${suffix}@example.test`,
            clerkId: `e2e_moment-${moment.id}-${index}-${suffix}`,
            name: participant.name,
            firstName: participant.name,
          },
        }),
      ),
    );
    const userByName = new Map(participants.map((participant, index) => [participant.name, users[index]]));
    const actor = userByName.get(actorName) || users[0];
    const partner = users.find(user => user.id !== actor.id) || users[1];

    const relationship = await tx.relationship.create({
      data: {
        members: {
          create: participants.map((participant, index) => ({
            userId: users[index].id,
            role: participant.role,
            nickname: participants.find((_, otherIndex) => otherIndex !== index)?.name || 'Partner',
          })),
        },
      },
    });

    const session = await tx.session.create({
      data: {
        relationshipId: relationship.id,
        status: 'ACTIVE',
        topicFrame: `${TEST_TOPIC_PREFIX} ${moment.id}`,
      },
    });

    const vessels = await Promise.all(
      users.map((user, index) =>
        tx.userVessel.create({
          data: {
            userId: user.id,
            sessionId: session.id,
            notableFacts: [
              {
                category: 'Moment',
                fact: `${participants[index].name} is seeded for ${moment.id} at Stage ${currentStage}.`,
              },
            ],
          },
        }),
      ),
    );
    await Promise.all(
      vessels.map(vessel =>
        tx.emotionalReading.create({
          data: {
            vesselId: vessel.id,
            intensity: 5,
            stage: currentStage,
            context: `Seeded baseline for ${moment.id}.`,
          },
        }),
      ),
    );

    const progressRows = participants.flatMap((participant, index) => {
      const gates = participant.stageGates || {};
      const rows = [];
      for (let stage = 0; stage <= currentStage; stage += 1) {
        rows.push({
          sessionId: session.id,
          userId: users[index].id,
          stage,
          status: stage < currentStage ? ('COMPLETED' as const) : ('IN_PROGRESS' as const),
          completedAt: stage < currentStage ? new Date() : null,
          gatesSatisfied: (gates[String(stage)] as object | undefined) || {},
        });
      }
      return rows;
    });
    await tx.stageProgress.createMany({ data: progressRows });

    const history = [];
    const summaries = moment.seed.prior_history_summary || [];
    for (const summary of summaries) {
      history.push(
        await tx.message.create({
          data: {
            sessionId: session.id,
            senderId: actor.id,
            role: 'USER',
            stage: currentStage,
            content: summary,
          },
        }),
      );
    }

    for (const proposal of moment.seed.proposals || []) {
      const owner = proposal.owner ? userByName.get(proposal.owner) : undefined;
      const created = await tx.strategyProposal.create({
        data: {
          sessionId: session.id,
          createdByUserId: owner?.id || actor.id,
          description: proposal.description,
          kind: proposal.kind === 'individual' ? 'INDIVIDUAL_COMMITMENT' : 'SHARED_PROPOSAL',
          needsAddressed: [],
          source: 'CURATED',
        },
      });
      for (const [userName, choice] of Object.entries(proposal.selectedBy || {})) {
        const selectedUser = userByName.get(userName);
        if (!selectedUser) continue;
        await tx.stage4ProposalSelection.create({
          data: {
            proposalId: created.id,
            sessionId: session.id,
            userId: selectedUser.id,
            decision: choice === 'NOT_WILLING' ? 'NOT_WILLING' : 'WILLING',
          },
        });
      }
    }

    const stageProgress = await tx.stageProgress.findMany({
      where: { sessionId: session.id },
      orderBy: [{ userId: 'asc' }, { stage: 'asc' }],
    });

    return {
      sessionId: session.id,
      actorUserId: actor.id,
      partnerUserId: partner.id,
      actorEmail: actor.email,
      rows: {
        Session: 1,
        Relationship: 1,
        RelationshipMember: users.length,
        User: users.length,
        UserVessel: vessels.length,
        StageProgress: stageProgress.length,
        Message: history.length,
      },
      messages: history.map(message => ({
        id: message.id,
        role: message.role,
        content: message.content,
        stage: message.stage,
      })),
      stageProgress: stageProgress.map(progress => ({
        userId: progress.userId,
        stage: progress.stage,
        status: progress.status,
        gatesSatisfied: progress.gatesSatisfied,
      })),
    };
  });

  return result;
}

function parseSse(raw: string): Array<{ event: string; data: unknown }> {
  return raw
    .split(/\n\n+/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const event = block.match(/^event:\s*(.+)$/m)?.[1] || 'message';
      const dataText = block.match(/^data:\s*(.+)$/m)?.[1] || '{}';
      let data: unknown = {};
      try {
        data = JSON.parse(dataText);
      } catch {
        data = dataText;
      }
      return { event, data };
    });
}

async function invokeStage1(seed: SeedResult, content: string): Promise<Record<string, unknown>> {
  requireEnv(['DATABASE_URL', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);

  const before = await prisma.message.findMany({
    where: { sessionId: seed.sessionId },
    orderBy: { timestamp: 'asc' },
  });

  const response = await request(app)
    .post(`/api/sessions/${seed.sessionId}/messages/stream`)
    .set('x-e2e-user-id', seed.actorUserId)
    .set('x-e2e-user-email', seed.actorEmail)
    .set('Accept', 'text/event-stream')
    .buffer(true)
    .parse((res, callback) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        raw += chunk;
      });
      res.on('end', () => callback(null, raw));
    })
    .send({ content });

  if (response.status !== 200) {
    throw new Error(`Backend stream returned ${response.status}: ${response.text || JSON.stringify(response.body)}`);
  }

  const rawSse = String(response.body || response.text || '');
  const events = parseSse(rawSse);
  const aiResponse = events
    .filter(event => event.event === 'chunk')
    .map(event => {
      const data = event.data as { text?: string };
      return data.text || '';
    })
    .join('');

  const after = await prisma.message.findMany({
    where: { sessionId: seed.sessionId },
    orderBy: { timestamp: 'asc' },
  });
  const beforeIds = new Set(before.map(message => message.id));
  const newMessages = after
    .filter(message => !beforeIds.has(message.id))
    .map(message => ({
      id: message.id,
      role: message.role,
      senderId: message.senderId,
      forUserId: message.forUserId,
      content: message.content,
      stage: message.stage,
    }));

  const stageProgress = await prisma.stageProgress.findMany({
    where: { sessionId: seed.sessionId },
    orderBy: [{ userId: 'asc' }, { stage: 'asc' }],
  });

  return {
    aiResponse,
    rawSse,
    events,
    stateDelta: {
      new_messages_in_db: newMessages,
      stage_progress: stageProgress.map(progress => ({
        userId: progress.userId,
        stage: progress.stage,
        status: progress.status,
        gatesSatisfied: progress.gatesSatisfied,
      })),
    },
  };
}

async function invokeSeed(seed: SeedResult, content: string): Promise<Record<string, unknown>> {
  return invokeStage1(seed, content);
}

async function invokeTrajectory(moment: MomentPayload): Promise<Record<string, unknown>> {
  const seed = await seedGenericMoment(moment);
  const steps = [];
  const responses = [];
  for (const [index, step] of (
    moment as MomentPayload & { trajectory?: Array<{ user_turn: string }> }
  ).trajectory?.entries() || []) {
    const run = await invokeSeed(seed, step.user_turn);
    const aiResponse = String(run.aiResponse || '');
    responses.push(aiResponse);
    steps.push({
      turn: index + 1,
      user_turn: step.user_turn,
      ai_response_persisted: aiResponse,
      seed_for_next_turn: {
        previous_ai_response: aiResponse,
        history_length_after_turn: (index + 1) * 2,
      },
      stateDelta: run.stateDelta,
    });
  }
  return {
    seed,
    aiResponse: responses.join('\n\n'),
    stateDelta: {
      trajectory_steps: steps,
      new_messages_in_db: steps.flatMap(
        step => (step.stateDelta as { new_messages_in_db?: unknown[] }).new_messages_in_db || [],
      ),
      stage_progress: steps.at(-1)?.stateDelta
        ? (steps.at(-1)?.stateDelta as { stage_progress?: unknown[] }).stage_progress || []
        : [],
    },
  };
}

async function cleanup(olderThanMs: number): Promise<Record<string, number>> {
  requireEnv(['DATABASE_URL']);
  const cutoff = new Date(Date.now() - olderThanMs);
  const sessions = await prisma.session.findMany({
    where: {
      // session.topic_frame is encrypted (TS-13): this prefix match works only
      // against a keyless dev database (dev script; ruling R45, documented only).
      topicFrame: { startsWith: TEST_TOPIC_PREFIX },
      createdAt: { lt: cutoff },
    },
    select: { id: true, relationshipId: true },
  });
  const relationshipIds = Array.from(new Set(sessions.map(session => session.relationshipId)));
  const userIds = await prisma.relationshipMember.findMany({
    where: { relationshipId: { in: relationshipIds } },
    select: { userId: true },
  });
  await prisma.relationship.deleteMany({ where: { id: { in: relationshipIds } } });
  await prisma.user.deleteMany({
    where: {
      id: { in: userIds.map(user => user.userId) },
      email: { contains: '@example.test' },
    },
  });
  return { sessions: sessions.length, relationships: relationshipIds.length, users: userIds.length };
}

async function judge(input: {
  systemPrompt: string;
  template: string;
  response: string;
  momentId: string;
}): Promise<Record<string, unknown>> {
  requireEnv(['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
  const client = new AnthropicBedrock({ awsRegion: process.env.AWS_REGION });
  const startedAt = Date.now();
  const result = await client.messages.create({
    model: HAIKU_MODEL_ID,
    max_tokens: 900,
    temperature: 0,
    system: [
      { type: 'text', text: input.systemPrompt, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: input.template, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: `AI response under evaluation:\n\n${input.response}\n\nReturn only JSON.`,
      },
    ],
  });
  const textBlock = result.content.find(block => block.type === 'text');
  const text = textBlock && textBlock.type === 'text' ? textBlock.text : '{}';
  let parsed: unknown;
  try {
    const cleaned = text
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = { parse_error: true, raw: text };
  }
  return {
    model: HAIKU_MODEL_ID,
    durationMs: Date.now() - startedAt,
    usage: result.usage,
    parsed,
    raw: text,
  };
}

async function generateRubric(input: {
  transcript: string;
  transcriptPath: string;
  aiTurn: {
    content: string;
    stage: number | null;
    subState: string;
    startLine: number;
    endLine: number;
  };
  trigger?: {
    content: string;
    speaker: string;
    startLine: number;
    endLine: number;
  } | null;
  protocolPosture: string;
  transcriptExcerpt: string;
}): Promise<Record<string, unknown>> {
  requireEnv(['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
  const client = new AnthropicBedrock({ awsRegion: process.env.AWS_REGION });
  const startedAt = Date.now();
  const result = await client.messages.create({
    model: HAIKU_MODEL_ID,
    max_tokens: 1400,
    temperature: 0,
    system: [
      {
        type: 'text',
        text:
          'You generate Meet Without Fear moment-evaluator rubric dimensions. Return only JSON. ' +
          'Create 3 to 5 dimensions anchored to the provided gold AI turn, stage posture, trigger, and transcript evidence. ' +
          'Each dimension must have id, description, pass_threshold, and evidence_excerpt. ' +
          'Do not score grammar or generic helpfulness; score MWF posture and protocol fidelity.',
      },
      {
        type: 'text',
        text: `Full gold transcript (${input.transcriptPath}):\n\n${input.transcript}`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content:
          `Protocol posture:\n${input.protocolPosture}\n\n` +
          `Chosen AI turn (${input.aiTurn.subState}, Stage ${input.aiTurn.stage}, lines ${input.aiTurn.startLine}-${input.aiTurn.endLine}):\n${input.aiTurn.content}\n\n` +
          `Immediately preceding trigger:\n${input.trigger ? `${input.trigger.speaker}: ${input.trigger.content}` : 'None'}\n\n` +
          `Surrounding transcript excerpt:\n${input.transcriptExcerpt}\n\n` +
          'Return JSON shaped as {"dimensions":[{"id":"...", "description":"...", "pass_threshold":4, "evidence_excerpt":"..."}]}.',
      },
    ],
  });
  const textBlock = result.content.find(block => block.type === 'text');
  const text = textBlock && textBlock.type === 'text' ? textBlock.text : '{}';
  let parsed: unknown;
  try {
    const cleaned = text
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = { parse_error: true, raw: text };
  }
  return {
    model: HAIKU_MODEL_ID,
    durationMs: Date.now() - startedAt,
    usage: result.usage,
    promptCaching: 'full transcript sent as cache_control ephemeral system block',
    parsed,
    raw: text,
  };
}

function parseOlderThan(value: string): number {
  const match = value.match(/^(\d+)([hd])$/);
  if (!match) throw new Error('--older-than must look like 1h or 1d');
  const amount = Number(match[1]);
  return amount * (match[2] === 'd' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000);
}

async function main(): Promise<void> {
  const [command, payloadText] = process.argv.slice(2);
  try {
    if (command === 'seed') {
      const seed = await seedStage1FactReflection();
      console.log(JSON.stringify(seed));
      return;
    }
    if (command === 'seed-generic') {
      const payload = JSON.parse(payloadText || '{}') as { moment?: MomentPayload };
      if (!payload.moment) throw new Error('seed-generic requires a moment payload');
      console.log(JSON.stringify(await seedGenericMoment(payload.moment)));
      return;
    }
    if (command === 'run') {
      const payload = JSON.parse(payloadText || '{}') as { content?: string; moment?: MomentPayload };
      const seed = payload.moment ? await seedGenericMoment(payload.moment) : await seedStage1FactReflection();
      const run = await invokeSeed(
        seed,
        payload.content ||
          "The thing I haven't said out loud is that I am scared she might be right about me. That I have held us back and I don't know how to be different.",
      );
      console.log(JSON.stringify({ seed, ...run }));
      return;
    }
    if (command === 'run-trajectory') {
      const payload = JSON.parse(payloadText || '{}') as { moment?: MomentPayload };
      if (!payload.moment) throw new Error('run-trajectory requires a moment payload');
      console.log(JSON.stringify(await invokeTrajectory(payload.moment)));
      return;
    }
    if (command === 'cleanup') {
      const result = await cleanup(parseOlderThan(payloadText || '1d'));
      console.log(JSON.stringify(result));
      return;
    }
    if (command === 'judge') {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      console.log(JSON.stringify(await judge(payload)));
      return;
    }
    if (command === 'rubric') {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      console.log(JSON.stringify(await generateRubric(payload)));
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(async error => {
  console.error(error instanceof Error ? error.message : String(error));
  await prisma.$disconnect();
  process.exit(2);
});
