import { prisma } from './lib/prisma';

async function main() {
  // Find and delete empty messages
  const emptyMessages = await prisma.message.findMany({
    where: {
      content: '',
    },
    select: {
      id: true,
      conversationId: true,
      role: true,
      createdAt: true,
    }
  });

  console.log('Found empty messages:', emptyMessages);

  if (emptyMessages.length > 0) {
    const deleted = await prisma.message.deleteMany({
      where: {
        content: '',
      }
    });
    console.log('Deleted', deleted.count, 'empty messages');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
