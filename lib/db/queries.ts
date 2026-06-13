import "server-only";

import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  type SQL,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { ArtifactKind } from "@/components/chat/artifact";
import type { VisibilityType } from "@/components/chat/visibility-selector";
import { ChatbotError } from "../errors";
import { generateUUID } from "../utils";
import {
  type Chat,
  chat,
  type DBMessage,
  type Document,
  document,
  file,
  fileChunk,
  type FileChunk,
  type FileRecord,
  message,
  type Suggestion,
  stream,
  suggestion,
  type User,
  user,
  type Vote,
  vote,
} from "./schema";
import { generateHashedPassword } from "./utils";

const client = postgres(process.env.POSTGRES_URL ?? "");
const db = drizzle(client);
const useMemoryDb = !process.env.POSTGRES_URL;

type MemoryDb = {
  users: User[];
  chats: Chat[];
  messages: DBMessage[];
  votes: Vote[];
  documents: Document[];
  files: FileRecord[];
  fileChunks: FileChunk[];
  suggestions: Suggestion[];
  streams: { id: string; chatId: string; createdAt: Date }[];
};

const createMemoryDb = (): MemoryDb => ({
  users: [] as User[],
  chats: [] as Chat[],
  messages: [] as DBMessage[],
  votes: [] as Vote[],
  documents: [] as Document[],
  files: [] as FileRecord[],
  fileChunks: [] as FileChunk[],
  suggestions: [] as Suggestion[],
  streams: [] as { id: string; chatId: string; createdAt: Date }[],
});

const globalForMemoryDb = globalThis as typeof globalThis & {
  __aiWorkbenchMemoryDb?: MemoryDb;
};

const memoryDb =
  globalForMemoryDb.__aiWorkbenchMemoryDb ?? (globalForMemoryDb.__aiWorkbenchMemoryDb = createMemoryDb());

type ChatIdInput = {
  id?: string;
  conversationId?: string;
};

function resolveChatId({ id, conversationId }: ChatIdInput) {
  return conversationId ?? id;
}

export async function getUser(email: string): Promise<User[]> {
  if (useMemoryDb) {
    return memoryDb.users.filter((currentUser) => currentUser.email === email);
  }

  try {
    return await db.select().from(user).where(eq(user.email, email));
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get user by email"
    );
  }
}

export async function createUser(email: string, password: string) {
  const hashedPassword = generateHashedPassword(password);

  if (useMemoryDb) {
    const now = new Date();
    memoryDb.users.push({
      id: generateUUID(),
      email,
      password: hashedPassword,
      name: null,
      emailVerified: false,
      image: null,
      isAnonymous: false,
      createdAt: now,
      updatedAt: now,
    });
    return;
  }

  try {
    return await db.insert(user).values({ email, password: hashedPassword });
  } catch (_error) {
    throw new ChatbotError("bad_request:database", "Failed to create user");
  }
}

export async function createGuestUser() {
  const email = `guest-${Date.now()}`;
  const password = generateHashedPassword(generateUUID());

  if (useMemoryDb) {
    const now = new Date();
    const guestUser = {
      id: generateUUID(),
      email,
      password,
      name: null,
      emailVerified: false,
      image: null,
      isAnonymous: true,
      createdAt: now,
      updatedAt: now,
    };
    memoryDb.users.push(guestUser);
    return [{ id: guestUser.id, email: guestUser.email }];
  }

  try {
    return await db.insert(user).values({ email, password }).returning({
      id: user.id,
      email: user.email,
    });
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to create guest user"
    );
  }
}

export async function saveChat({
  id,
  userId,
  title,
  visibility,
}: {
  id: string;
  userId: string;
  title: string;
  visibility: VisibilityType;
}) {
  if (useMemoryDb) {
    const now = new Date();
    memoryDb.chats.push({
      id,
      createdAt: now,
      updatedAt: now,
      userId,
      title,
      visibility,
    });
    return;
  }

  try {
    const now = new Date();
    return await db.insert(chat).values({
      id,
      createdAt: now,
      updatedAt: now,
      userId,
      title,
      visibility,
    });
  } catch (_error) {
    throw new ChatbotError("bad_request:database", "Failed to save chat");
  }
}

export async function deleteChatById(input: ChatIdInput) {
  const conversationId = resolveChatId(input);

  if (!conversationId) {
    throw new ChatbotError("bad_request:database", "Chat id is required");
  }

  if (useMemoryDb) {
    const selectedChat = memoryDb.chats.find((currentChat) => currentChat.id === conversationId);
    memoryDb.votes = memoryDb.votes.filter((currentVote) => currentVote.chatId !== conversationId);
    memoryDb.messages = memoryDb.messages.filter((currentMessage) => currentMessage.chatId !== conversationId);
    memoryDb.streams = memoryDb.streams.filter((currentStream) => currentStream.chatId !== conversationId);
    memoryDb.fileChunks = memoryDb.fileChunks.filter((currentChunk) => currentChunk.chatId !== conversationId);
    memoryDb.files = memoryDb.files.filter((currentFile) => currentFile.chatId !== conversationId);
    memoryDb.chats = memoryDb.chats.filter((currentChat) => currentChat.id !== conversationId);
    return selectedChat;
  }

  try {
    await db.delete(vote).where(eq(vote.chatId, conversationId));
    await db.delete(message).where(eq(message.chatId, conversationId));
    await db.delete(stream).where(eq(stream.chatId, conversationId));
    await db.delete(fileChunk).where(eq(fileChunk.chatId, conversationId));
    await db.delete(file).where(eq(file.chatId, conversationId));

    const [chatsDeleted] = await db
      .delete(chat)
      .where(eq(chat.id, conversationId))
      .returning();
    return chatsDeleted;
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to delete chat by id"
    );
  }
}

export async function deleteAllChatsByUserId({ userId }: { userId: string }) {
  if (useMemoryDb) {
    const chatIds = memoryDb.chats
      .filter((currentChat) => currentChat.userId === userId)
      .map((currentChat) => currentChat.id);
    memoryDb.votes = memoryDb.votes.filter((currentVote) => !chatIds.includes(currentVote.chatId));
    memoryDb.messages = memoryDb.messages.filter((currentMessage) => !chatIds.includes(currentMessage.chatId));
    memoryDb.streams = memoryDb.streams.filter((currentStream) => !chatIds.includes(currentStream.chatId));
    memoryDb.fileChunks = memoryDb.fileChunks.filter(
      (currentChunk) => !currentChunk.chatId || !chatIds.includes(currentChunk.chatId)
    );
    memoryDb.chats = memoryDb.chats.filter((currentChat) => currentChat.userId !== userId);
    return { deletedCount: chatIds.length };
  }

  try {
    const userChats = await db
      .select({ id: chat.id })
      .from(chat)
      .where(eq(chat.userId, userId));

    if (userChats.length === 0) {
      return { deletedCount: 0 };
    }

    const chatIds = userChats.map((c) => c.id);

    await db.delete(vote).where(inArray(vote.chatId, chatIds));
    await db.delete(message).where(inArray(message.chatId, chatIds));
    await db.delete(stream).where(inArray(stream.chatId, chatIds));
    await db.delete(fileChunk).where(inArray(fileChunk.chatId, chatIds));

    const deletedChats = await db
      .delete(chat)
      .where(eq(chat.userId, userId))
      .returning();

    return { deletedCount: deletedChats.length };
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to delete all chats by user id"
    );
  }
}

export async function getChatsByUserId({
  id,
  limit,
  startingAfter,
  endingBefore,
}: {
  id: string;
  limit: number;
  startingAfter: string | null;
  endingBefore: string | null;
}) {
  if (useMemoryDb) {
    let filteredChats = memoryDb.chats
      .filter((currentChat) => currentChat.userId === id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    if (startingAfter) {
      const selectedChat = memoryDb.chats.find((currentChat) => currentChat.id === startingAfter);
      filteredChats = selectedChat
        ? filteredChats.filter((currentChat) => currentChat.createdAt > selectedChat.createdAt)
        : [];
    } else if (endingBefore) {
      const selectedChat = memoryDb.chats.find((currentChat) => currentChat.id === endingBefore);
      filteredChats = selectedChat
        ? filteredChats.filter((currentChat) => currentChat.createdAt < selectedChat.createdAt)
        : [];
    }

    const hasMore = filteredChats.length > limit;
    return {
      chats: hasMore ? filteredChats.slice(0, limit) : filteredChats,
      hasMore,
    };
  }

  try {
    const extendedLimit = limit + 1;

    const query = (whereCondition?: SQL<unknown>) =>
      db
        .select()
        .from(chat)
        .where(
          whereCondition
            ? and(whereCondition, eq(chat.userId, id))
            : eq(chat.userId, id)
        )
        .orderBy(desc(chat.createdAt))
        .limit(extendedLimit);

    let filteredChats: Chat[] = [];

    if (startingAfter) {
      const [selectedChat] = await db
        .select()
        .from(chat)
        .where(eq(chat.id, startingAfter))
        .limit(1);

      if (!selectedChat) {
        throw new ChatbotError(
          "not_found:database",
          `Chat with id ${startingAfter} not found`
        );
      }

      filteredChats = await query(gt(chat.createdAt, selectedChat.createdAt));
    } else if (endingBefore) {
      const [selectedChat] = await db
        .select()
        .from(chat)
        .where(eq(chat.id, endingBefore))
        .limit(1);

      if (!selectedChat) {
        throw new ChatbotError(
          "not_found:database",
          `Chat with id ${endingBefore} not found`
        );
      }

      filteredChats = await query(lt(chat.createdAt, selectedChat.createdAt));
    } else {
      filteredChats = await query();
    }

    const hasMore = filteredChats.length > limit;

    return {
      chats: hasMore ? filteredChats.slice(0, limit) : filteredChats,
      hasMore,
    };
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get chats by user id"
    );
  }
}

export async function getChatById(input: ChatIdInput) {
  const conversationId = resolveChatId(input);

  if (!conversationId) {
    throw new ChatbotError("bad_request:database", "Chat id is required");
  }

  if (useMemoryDb) {
    return memoryDb.chats.find((currentChat) => currentChat.id === conversationId) ?? null;
  }

  try {
    const [selectedChat] = await db.select().from(chat).where(eq(chat.id, conversationId));
    if (!selectedChat) {
      return null;
    }

    return selectedChat;
  } catch (_error) {
    throw new ChatbotError("bad_request:database", "Failed to get chat by id");
  }
}

export async function saveMessages({ messages }: { messages: DBMessage[] }) {
  if (useMemoryDb) {
    memoryDb.messages.push(...messages);
    return;
  }

  try {
    return await db.insert(message).values(messages);
  } catch (_error) {
    throw new ChatbotError("bad_request:database", "Failed to save messages");
  }
}

export async function updateMessage({
  id,
  parts,
  status,
}: {
  id: string;
  parts?: DBMessage["parts"];
  status?: DBMessage["status"];
}) {
  if (useMemoryDb) {
    memoryDb.messages = memoryDb.messages.map((currentMessage) => {
      if (currentMessage.id === id) {
        const updated: any = { ...currentMessage };
        if (parts !== undefined) updated.parts = parts;
        if (status !== undefined) updated.status = status;
        updated.updatedAt = new Date();
        return updated;
      }
      return currentMessage;
    });
    return;
  }

  try {
    const updates: any = { updatedAt: new Date() };
    if (parts !== undefined) updates.parts = parts;
    if (status !== undefined) updates.status = status;
    return await db.update(message).set(updates).where(eq(message.id, id));
  } catch (_error) {
    throw new ChatbotError("bad_request:database", "Failed to update message");
  }
}

export async function getMessagesByChatId(input: ChatIdInput) {
  const conversationId = resolveChatId(input);

  if (!conversationId) {
    throw new ChatbotError("bad_request:database", "Chat id is required");
  }

  if (useMemoryDb) {
    return memoryDb.messages
      .filter((currentMessage) => currentMessage.chatId === conversationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  try {
    return await db
      .select()
      .from(message)
      .where(eq(message.chatId, conversationId))
      .orderBy(asc(message.createdAt));
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get messages by chat id"
    );
  }
}

export async function voteMessage({
  chatId,
  messageId,
  type,
}: {
  chatId: string;
  messageId: string;
  type: "up" | "down";
}) {
  if (useMemoryDb) {
    const existingVote = memoryDb.votes.find(
      (currentVote) => currentVote.chatId === chatId && currentVote.messageId === messageId
    );
    if (existingVote) {
      existingVote.isUpvoted = type === "up";
      return;
    }
    memoryDb.votes.push({ chatId, messageId, isUpvoted: type === "up" });
    return;
  }

  try {
    const [existingVote] = await db
      .select()
      .from(vote)
      .where(and(eq(vote.messageId, messageId)));

    if (existingVote) {
      return await db
        .update(vote)
        .set({ isUpvoted: type === "up" })
        .where(and(eq(vote.messageId, messageId), eq(vote.chatId, chatId)));
    }
    return await db.insert(vote).values({
      chatId,
      messageId,
      isUpvoted: type === "up",
    });
  } catch (_error) {
    throw new ChatbotError("bad_request:database", "Failed to vote message");
  }
}

export async function getVotesByChatId(input: ChatIdInput) {
  const conversationId = resolveChatId(input);

  if (!conversationId) {
    throw new ChatbotError("bad_request:database", "Chat id is required");
  }

  if (useMemoryDb) {
    return memoryDb.votes.filter((currentVote) => currentVote.chatId === conversationId);
  }

  try {
    return await db.select().from(vote).where(eq(vote.chatId, conversationId));
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get votes by chat id"
    );
  }
}

export async function saveUploadedFile({
  id,
  userId,
  chatId,
  originalName,
  storedName,
  url,
  mimeType,
  size,
  content,
  parseStatus,
}: {
  id?: string;
  userId: string;
  chatId?: string | null;
  originalName: string;
  storedName: string;
  url: string;
  mimeType: string;
  size: number;
  content?: string | null;
  parseStatus: FileRecord["parseStatus"];
}) {
  const now = new Date();

  if (useMemoryDb) {
    const savedFile: FileRecord = {
      id: id ?? generateUUID(),
      userId,
      chatId: chatId ?? null,
      originalName,
      storedName,
      url,
      mimeType,
      size,
      content: content ?? null,
      parseStatus,
      createdAt: now,
      updatedAt: now,
    };
    memoryDb.files.push(savedFile);
    return [savedFile];
  }

  try {
    return await db
      .insert(file)
      .values({
        userId,
        ...(id ? { id } : {}),
        chatId: chatId ?? null,
        originalName,
        storedName,
        url,
        mimeType,
        size,
        content: content ?? null,
        parseStatus,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
  } catch (_error) {
    throw new ChatbotError("bad_request:database", "Failed to save file");
  }
}

export async function getFilesByIdsForUser({
  ids,
  userId,
  chatId,
}: {
  ids: string[];
  userId: string;
  chatId?: string | null;
}) {
  if (ids.length === 0) {
    return [];
  }

  if (useMemoryDb) {
    return memoryDb.files.filter(
      (currentFile) =>
        ids.includes(currentFile.id) &&
        currentFile.userId === userId &&
        (!chatId || !currentFile.chatId || currentFile.chatId === chatId)
    );
  }

  try {
    const rows = await db
      .select()
      .from(file)
      .where(and(inArray(file.id, ids), eq(file.userId, userId)));

    return rows.filter(
      (currentFile) =>
        !chatId || !currentFile.chatId || currentFile.chatId === chatId
    );
  } catch (_error) {
    throw new ChatbotError("bad_request:database", "Failed to get files");
  }
}

export async function getFilesByChatIdForUser({
  chatId,
  userId,
}: {
  chatId: string;
  userId: string;
}) {
  if (useMemoryDb) {
    return memoryDb.files.filter(
      (currentFile) =>
        currentFile.chatId === chatId && currentFile.userId === userId
    );
  }

  try {
    return await db
      .select()
      .from(file)
      .where(and(eq(file.chatId, chatId), eq(file.userId, userId)));
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get files by chat id"
    );
  }
}

export async function saveFileChunks({
  chunks,
}: {
  chunks: Array<{
    fileId: string;
    userId: string;
    chatId?: string | null;
    chunkIndex: number;
    content: string;
    charCount: number;
  }>;
}) {
  if (chunks.length === 0) {
    return [];
  }

  const now = new Date();

  if (useMemoryDb) {
    const savedChunks: FileChunk[] = chunks.map((chunk) => ({
      id: generateUUID(),
      fileId: chunk.fileId,
      userId: chunk.userId,
      chatId: chunk.chatId ?? null,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      charCount: chunk.charCount,
      createdAt: now,
    }));
    memoryDb.fileChunks.push(...savedChunks);
    return savedChunks;
  }

  try {
    return await db
      .insert(fileChunk)
      .values(
        chunks.map((chunk) => ({
          fileId: chunk.fileId,
          userId: chunk.userId,
          chatId: chunk.chatId ?? null,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          charCount: chunk.charCount,
          createdAt: now,
        }))
      )
      .returning();
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to save file chunks"
    );
  }
}

export async function getFileChunksByFileIdsForUser({
  fileIds,
  userId,
  chatId,
}: {
  fileIds: string[];
  userId: string;
  chatId?: string | null;
}) {
  if (fileIds.length === 0) {
    return [];
  }

  if (useMemoryDb) {
    return memoryDb.fileChunks
      .filter(
        (currentChunk) =>
          fileIds.includes(currentChunk.fileId) &&
          currentChunk.userId === userId &&
          (!chatId || !currentChunk.chatId || currentChunk.chatId === chatId)
      )
      .sort((a, b) =>
        a.fileId === b.fileId
          ? a.chunkIndex - b.chunkIndex
          : a.fileId.localeCompare(b.fileId)
      );
  }

  try {
    const rows = await db
      .select()
      .from(fileChunk)
      .where(and(inArray(fileChunk.fileId, fileIds), eq(fileChunk.userId, userId)))
      .orderBy(asc(fileChunk.fileId), asc(fileChunk.chunkIndex));

    return rows.filter(
      (currentChunk) =>
        !chatId || !currentChunk.chatId || currentChunk.chatId === chatId
    );
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get file chunks"
    );
  }
}

export async function deleteFileByIdForUser({
  id,
  userId,
}: {
  id: string;
  userId: string;
}) {
  if (useMemoryDb) {
    const selectedFile =
      memoryDb.files.find(
        (currentFile) => currentFile.id === id && currentFile.userId === userId
      ) ?? null;

    if (!selectedFile) {
      return null;
    }

    memoryDb.fileChunks = memoryDb.fileChunks.filter(
      (currentChunk) => currentChunk.fileId !== id
    );
    memoryDb.files = memoryDb.files.filter(
      (currentFile) => !(currentFile.id === id && currentFile.userId === userId)
    );

    return selectedFile;
  }

  try {
    await db
      .delete(fileChunk)
      .where(and(eq(fileChunk.fileId, id), eq(fileChunk.userId, userId)));

    const [deletedFile] = await db
      .delete(file)
      .where(and(eq(file.id, id), eq(file.userId, userId)))
      .returning();

    return deletedFile ?? null;
  } catch (_error) {
    throw new ChatbotError("bad_request:database", "Failed to delete file");
  }
}

export async function saveDocument({
  id,
  title,
  kind,
  content,
  userId,
}: {
  id: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  userId: string;
}) {
  if (useMemoryDb) {
    const createdAt = new Date();
    const savedDocument = {
      id,
      title,
      kind,
      content,
      userId,
      createdAt,
    };
    memoryDb.documents.push(savedDocument);
    return [savedDocument];
  }

  try {
    return await db
      .insert(document)
      .values({
        id,
        title,
        kind,
        content,
        userId,
        createdAt: new Date(),
      })
      .returning();
  } catch (_error) {
    throw new ChatbotError("bad_request:database", "Failed to save document");
  }
}

export async function updateDocumentContent({
  id,
  content,
}: {
  id: string;
  content: string;
}) {
  if (useMemoryDb) {
    const latest = memoryDb.documents
      .filter((currentDocument) => currentDocument.id === id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (!latest) {
      throw new ChatbotError("not_found:database", "Document not found");
    }
    latest.content = content;
    return [latest];
  }

  try {
    const docs = await db
      .select()
      .from(document)
      .where(eq(document.id, id))
      .orderBy(desc(document.createdAt))
      .limit(1);

    const latest = docs[0];
    if (!latest) {
      throw new ChatbotError("not_found:database", "Document not found");
    }

    return await db
      .update(document)
      .set({ content })
      .where(and(eq(document.id, id), eq(document.createdAt, latest.createdAt)))
      .returning();
  } catch (_error) {
    if (_error instanceof ChatbotError) {
      throw _error;
    }
    throw new ChatbotError(
      "bad_request:database",
      "Failed to update document content"
    );
  }
}

export async function getDocumentsById({ id }: { id: string }) {
  if (useMemoryDb) {
    return memoryDb.documents
      .filter((currentDocument) => currentDocument.id === id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  try {
    const documents = await db
      .select()
      .from(document)
      .where(eq(document.id, id))
      .orderBy(asc(document.createdAt));

    return documents;
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get documents by id"
    );
  }
}

export async function getDocumentById({ id }: { id: string }) {
  if (useMemoryDb) {
    return memoryDb.documents
      .filter((currentDocument) => currentDocument.id === id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  }

  try {
    const [selectedDocument] = await db
      .select()
      .from(document)
      .where(eq(document.id, id))
      .orderBy(desc(document.createdAt));

    return selectedDocument;
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get document by id"
    );
  }
}

export async function deleteDocumentsByIdAfterTimestamp({
  id,
  timestamp,
}: {
  id: string;
  timestamp: Date;
}) {
  if (useMemoryDb) {
    const deletedDocuments = memoryDb.documents.filter(
      (currentDocument) => currentDocument.id === id && currentDocument.createdAt > timestamp
    );
    memoryDb.suggestions = memoryDb.suggestions.filter(
      (currentSuggestion) =>
        !(currentSuggestion.documentId === id && currentSuggestion.documentCreatedAt > timestamp)
    );
    memoryDb.documents = memoryDb.documents.filter(
      (currentDocument) => !(currentDocument.id === id && currentDocument.createdAt > timestamp)
    );
    return deletedDocuments;
  }

  try {
    await db
      .delete(suggestion)
      .where(
        and(
          eq(suggestion.documentId, id),
          gt(suggestion.documentCreatedAt, timestamp)
        )
      );

    return await db
      .delete(document)
      .where(and(eq(document.id, id), gt(document.createdAt, timestamp)))
      .returning();
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to delete documents by id after timestamp"
    );
  }
}

export async function saveSuggestions({
  suggestions,
}: {
  suggestions: Suggestion[];
}) {
  if (useMemoryDb) {
    memoryDb.suggestions.push(...suggestions);
    return;
  }

  try {
    return await db.insert(suggestion).values(suggestions);
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to save suggestions"
    );
  }
}

export async function getSuggestionsByDocumentId({
  documentId,
}: {
  documentId: string;
}) {
  if (useMemoryDb) {
    return memoryDb.suggestions.filter(
      (currentSuggestion) => currentSuggestion.documentId === documentId
    );
  }

  try {
    return await db
      .select()
      .from(suggestion)
      .where(eq(suggestion.documentId, documentId));
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get suggestions by document id"
    );
  }
}

export async function getMessageById({ id }: { id: string }) {
  if (useMemoryDb) {
    return memoryDb.messages.filter((currentMessage) => currentMessage.id === id);
  }

  try {
    return await db.select().from(message).where(eq(message.id, id));
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get message by id"
    );
  }
}

export async function deleteMessagesByChatIdAfterTimestamp({
  chatId,
  timestamp,
}: {
  chatId: string;
  timestamp: Date;
}) {
  if (useMemoryDb) {
    const messageIds = memoryDb.messages
      .filter(
        (currentMessage) =>
          currentMessage.chatId === chatId && currentMessage.createdAt >= timestamp
      )
      .map((currentMessage) => currentMessage.id);
    memoryDb.votes = memoryDb.votes.filter(
      (currentVote) =>
        !(currentVote.chatId === chatId && messageIds.includes(currentVote.messageId))
    );
    memoryDb.messages = memoryDb.messages.filter(
      (currentMessage) =>
        !(currentMessage.chatId === chatId && messageIds.includes(currentMessage.id))
    );
    return;
  }

  try {
    const messagesToDelete = await db
      .select({ id: message.id })
      .from(message)
      .where(
        and(eq(message.chatId, chatId), gte(message.createdAt, timestamp))
      );

    const messageIds = messagesToDelete.map(
      (currentMessage) => currentMessage.id
    );

    if (messageIds.length > 0) {
      await db
        .delete(vote)
        .where(
          and(eq(vote.chatId, chatId), inArray(vote.messageId, messageIds))
        );

      return await db
        .delete(message)
        .where(
          and(eq(message.chatId, chatId), inArray(message.id, messageIds))
        );
    }
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to delete messages by chat id after timestamp"
    );
  }
}

export async function updateChatVisibilityById({
  chatId,
  visibility,
}: {
  chatId: string;
  visibility: "private" | "public";
}) {
  if (useMemoryDb) {
    memoryDb.chats = memoryDb.chats.map((currentChat) =>
      currentChat.id === chatId ? { ...currentChat, visibility } : currentChat
    );
    return;
  }

  try {
    return await db.update(chat).set({ visibility }).where(eq(chat.id, chatId));
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to update chat visibility by id"
    );
  }
}

export async function updateChatTitleById({
  chatId,
  title,
}: {
  chatId: string;
  title: string;
}) {
  if (useMemoryDb) {
    memoryDb.chats = memoryDb.chats.map((currentChat) =>
      currentChat.id === chatId ? { ...currentChat, title } : currentChat
    );
    return;
  }

  try {
    return await db.update(chat).set({ title }).where(eq(chat.id, chatId));
  } catch (_error) {
    return;
  }
}

export async function getMessageCountByUserId({
  id,
  differenceInHours,
}: {
  id: string;
  differenceInHours: number;
}) {
  if (useMemoryDb) {
    const cutoffTime = new Date(Date.now() - differenceInHours * 60 * 60 * 1000);
    const userChatIds = memoryDb.chats
      .filter((currentChat) => currentChat.userId === id)
      .map((currentChat) => currentChat.id);
    return memoryDb.messages.filter(
      (currentMessage) =>
        userChatIds.includes(currentMessage.chatId) &&
        currentMessage.createdAt >= cutoffTime &&
        currentMessage.role === "user"
    ).length;
  }

  try {
    const cutoffTime = new Date(
      Date.now() - differenceInHours * 60 * 60 * 1000
    );

    const [stats] = await db
      .select({ count: count(message.id) })
      .from(message)
      .innerJoin(chat, eq(message.chatId, chat.id))
      .where(
        and(
          eq(chat.userId, id),
          gte(message.createdAt, cutoffTime),
          eq(message.role, "user")
        )
      )
      .execute();

    return stats?.count ?? 0;
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get message count by user id"
    );
  }
}

export async function createStreamId({
  streamId,
  chatId,
}: {
  streamId: string;
  chatId: string;
}) {
  if (useMemoryDb) {
    memoryDb.streams.push({ id: streamId, chatId, createdAt: new Date() });
    return;
  }

  try {
    await db
      .insert(stream)
      .values({ id: streamId, chatId, createdAt: new Date() });
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to create stream id"
    );
  }
}

export async function getStreamIdsByChatId({ chatId }: { chatId: string }) {
  if (useMemoryDb) {
    return memoryDb.streams
      .filter((currentStream) => currentStream.chatId === chatId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((currentStream) => currentStream.id);
  }

  try {
    const streamIds = await db
      .select({ id: stream.id })
      .from(stream)
      .where(eq(stream.chatId, chatId))
      .orderBy(asc(stream.createdAt))
      .execute();

    return streamIds.map(({ id }) => id);
  } catch (_error) {
    throw new ChatbotError(
      "bad_request:database",
      "Failed to get stream ids by chat id"
    );
  }
}
