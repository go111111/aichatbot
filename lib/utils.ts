import type {
  UIMessage,
  UIMessagePart,
} from 'ai';
import { type ClassValue, clsx } from 'clsx';
import { formatISO } from 'date-fns';
import { twMerge } from 'tailwind-merge';
import type { DBMessage, Document } from '@/lib/db/schema';
import { ChatbotError, type ErrorCode } from './errors';
import type { ChatMessage, ChatTools, CustomUIDataTypes } from './types';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const fetcher = async (url: string) => {
  const response = await fetch(url);

  if (!response.ok) {
    const { code, cause } = await response.json();
    throw new ChatbotError(code as ErrorCode, cause);
  }

  return response.json();
};

export async function fetchWithErrorHandlers(
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  try {
    const response = await fetch(input, init);

    if (!response.ok) {
      const { code, cause } = await response.json();
      throw new ChatbotError(code as ErrorCode, cause);
    }

    return response;
  } catch (error: unknown) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new ChatbotError('offline:chat');
    }

    throw error;
  }
}

export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function getDocumentTimestampByIndex(
  documents: Document[],
  index: number,
) {
  if (!documents) { return new Date(); }
  if (index > documents.length) { return new Date(); }

  return documents[index].createdAt;
}

/**
 * Remove dangerous HTML and JavaScript patterns from text
 * to prevent XSS attacks while preserving safe content
 */
export function sanitizeText(text: string) {
  return text
    .replace('<has_function_call>', '')
    // Remove script tags
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    // Remove event handlers
    .replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\bon\w+\s*=\s*[^\s>]*/gi, '')
    // Remove javascript: protocol
    .replace(/javascript:/gi, '')
    // Remove data: protocol for scripts
    .replace(/data:text\/javascript/gi, '')
    .replace(/data:application\/javascript/gi, '');
}

/**
 * Sanitize HTML content for safe rendering
 * Removes dangerous tags and attributes while preserving formatting
 */
export function sanitizeHtml(html: string): string {
  const temp = document.createElement('div');

  // Allowed tags for Markdown content
  const allowedTags = new Set([
    'p', 'br', 'strong', 'em', 'u', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'code', 'pre', 'blockquote', 'a', 'table', 'tr',
    'td', 'th', 'thead', 'tbody', 'img', 'hr', 'del', 's', 'span', 'div'
  ]);

  temp.innerHTML = html;

  // Remove all script tags and event handlers
  const scripts = temp.querySelectorAll('script');
  scripts.forEach(s => s.remove());

  // Walk through all elements and remove dangerous ones
  const walker = document.createTreeWalker(
    temp,
    NodeFilter.SHOW_ELEMENT,
    null
  );

  const nodesToRemove: Element[] = [];
  let node: Node | null;

  while (node = walker.nextNode()) {
    const element = node as Element;

    // Remove disallowed tags
    if (!allowedTags.has(element.tagName.toLowerCase())) {
      nodesToRemove.push(element);
      continue;
    }

    // Remove all event handlers
    Array.from(element.attributes).forEach(attr => {
      if (attr.name.toLowerCase().startsWith('on')) {
        element.removeAttribute(attr.name);
      }
    });

    // Remove dangerous attributes
    const dangerousAttrs = ['javascript:', 'data:', 'vbscript:'];
    Array.from(element.attributes).forEach(attr => {
      const value = attr.value.toLowerCase();
      if (dangerousAttrs.some(dangerous => value.includes(dangerous))) {
        element.removeAttribute(attr.name);
      }
    });

    // Restrict href to safe protocols
    if (element.tagName.toLowerCase() === 'a') {
      const href = element.getAttribute('href') || '';
      if (href.toLowerCase().startsWith('javascript:') ||
          href.toLowerCase().startsWith('data:')) {
        element.removeAttribute('href');
      }
    }

    // Restrict src for images
    if (element.tagName.toLowerCase() === 'img') {
      const src = element.getAttribute('src') || '';
      if (src.toLowerCase().startsWith('javascript:') ||
          src.toLowerCase().startsWith('data:text/html')) {
        element.removeAttribute('src');
      }
    }
  }

  // Remove marked nodes
  nodesToRemove.forEach(node => node.remove());

  return temp.innerHTML;
}

export function convertToUIMessages(messages: DBMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role as 'user' | 'assistant' | 'system',
    parts: message.parts as UIMessagePart<CustomUIDataTypes, ChatTools>[],
    metadata: {
      createdAt: formatISO(message.createdAt),
      updatedAt: message.updatedAt ? formatISO(message.updatedAt) : undefined,
      status: (message.status as any) || 'done',
      requestId: message.requestId ?? undefined,
    },
  }));
}

export function getTextFromMessage(message: ChatMessage | UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part as { type: 'text'; text: string}).text)
    .join('');
}
