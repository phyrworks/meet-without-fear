import { prisma } from './lib/prisma';

async function main() {
  // Find and delete empty messages.
  // message.content is encrypted (TS-13): `content: ''` matches only on a keyless
  // dev database — with a key, even an empty string is stored as ciphertext
  // (dev script; ruling R45, documented only).
  const emptyMessages = await prisma.message.findMany({
    where: {
      content: '',
    },
    select: {
      id: true,
      conversationId: true,
      role: true,
      createdAt: true,
    },
  });

  console.log('Found empty messages:', emptyMessages);

  if (emptyMessages.length > 0) {
    const deleted = await prisma.message.deleteMany({
      where: {
        content: '',
      },
    });
    console.log('Deleted', deleted.count, 'empty messages');
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
