# API Documentation Updates

## Conversation & Messaging APIs

### 1. POST /api/chat - Main conversation endpoint

**Enhanced Features:**
- **Message Status Tracking**: Messages now track their lifecycle (pending → streaming → done/aborted)
- **Request ID Tracking**: Each streaming request gets a unique `requestId` for recovery
- **Streaming Configuration**: Explicit `stream` parameter to control response format
- **Improved Error Handling**: Clear error messages for parameter validation

**Request Body:**
```json
{
  "conversationId": "uuid",           // CHANGED from 'id' - unique conversation identifier
  "message": {                         // Last user message (not needed if messages array provided)
    "role": "user",
    "parts": [
      { "type": "text", "text": "..." }
    ]
  },
  "messages": [{...}],                // OPTIONAL - for tool approval continuation
  "selectedChatModel": "string",      // AI model to use
  "selectedVisibilityType": "string", // public|private
  "stream": true,                     // NEW - enable streaming response
  "requestId": "uuid"                 // NEW OPTIONAL - for request tracking
}
```

**Response Chunks (when streaming):**
```json
{
  "type": "id",
  "id": "message-uuid"
}
{
  "type": "content_block_start",
  "content_block": {
    "type": "text",
    "text": ""
  }
}
{
  "type": "content_block_delta",
  "delta": {
    "type": "text_delta",
    "text": "partial response..."
  }
}
{
  "type": "content_block_stop"
}
{
  "type": "message_stop"
}
```

**Message Status Lifecycle:**
- `pending` - Message created, processing hasn't started
- `streaming` - Response is being streamed from AI model
- `done` - Streaming completed successfully
- `error` - Error occurred during processing
- `aborted` - Stream was interrupted by user/client

**Error Response:**
```json
{
  "code": "bad_request:api|unauthorized:chat|forbidden:chat",
  "message": "User-friendly error message",
  "cause": "Technical details (optional)"
}
```

---

### 2. GET /api/messages - Load conversation history

**Query Parameters:**
```
chatId (required): uuid - Conversation ID
```

**Response:**
```json
{
  "messages": [
    {
      "id": "uuid",
      "role": "user|assistant|system",
      "chatId": "uuid",
      "parts": [...],
      "status": "done|pending|streaming|error|aborted",  // NEW
      "requestId": "uuid",                                // NEW - if applicable
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-01-01T00:00:00Z"                 // NEW
    }
  ]
}
```

---

### 3. GET/DELETE /api/vote - Message voting

**Enhanced to use conversationId parameter:**

**GET Request:**
```
/api/vote?chatId=<conversationId>
```

**Response:**
```json
[
  {
    "chatId": "uuid",
    "messageId": "uuid",
    "isUpvoted": boolean
  }
]
```

---

### 4. POST /api/upload - File upload (NEW)

**Features:**
- Supports JPEG, PNG, WebP, GIF, PDF
- Max file size: 20MB
- Automatic filename generation with UUID

**Request:**
```
POST /api/upload
Content-Type: multipart/form-data

file: File  // The file to upload
```

**Response:**
```json
{
  "url": "/uploads/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.ext",
  "name": "original_filename.ext",
  "size": 1024000,
  "type": "image/jpeg|image/png|application/pdf|..."
}
```

**Error Response:**
```json
{
  "code": "bad_request:upload|unauthorized:upload",
  "message": "File type not allowed|File size exceeds limit|...",
  "cause": "..."
}
```

**DELETE Request:**
```
DELETE /api/upload?name=<filename>
```

---

### 5. GET/POST /api/resume - Conversation recovery (NEW)

**GET - Retrieve message history:**
```
GET /api/resume?conversationId=<uuid>&lastMessageId=<uuid>&limit=50
```

**Query Parameters:**
```
conversationId (required): uuid
lastMessageId (optional): uuid - Get messages after this ID
limit (optional): number (1-100, default: 50)
```

**Response:**
```json
{
  "conversationId": "uuid",
  "messages": [...],
  "hasMore": true,
  "lastMessageTimestamp": "2024-01-01T00:00:00Z"
}
```

**POST - Check request status for reconnection:**
```
POST /api/resume/reconnect
Content-Type: application/json

{
  "conversationId": "uuid",
  "requestId": "uuid"
}
```

**Response:**
```json
{
  "conversationId": "uuid",
  "requestId": "uuid",
  "status": "done|pending|streaming|error|aborted",
  "lastMessageId": "uuid",
  "canReconnect": true,
  "partialContent": [...]  // Available if status is pending/streaming
}
```

---

## Database Schema Changes

### Message Table (Message_v2)

**New Fields:**
```sql
status VARCHAR(20) CHECK (status IN ('pending', 'streaming', 'done', 'error', 'aborted'))
  DEFAULT 'done' - Tracks message processing state
  
requestId UUID - Associates message with specific streaming request
  Allows tracking and resuming individual API calls

updatedAt TIMESTAMP DEFAULT now() - Last modification time
  Updated whenever message parts or status change
```

**New Indexes for Performance:**
```sql
idx_message_chat_status - On (chatId, status) for quick status lookups
idx_message_chat_created - On (chatId, createdAt DESC) for chronological queries
```

### Chat Table

**New Field:**
```sql
updatedAt TIMESTAMP DEFAULT now() - Tracks last chat modification
```

---

## Type System Updates

### MessageMetadata

```typescript
export interface MessageMetadata {
  createdAt: string;           // ISO timestamp
  updatedAt?: string;          // ISO timestamp - when message was last updated
  status?: 'pending' | 'streaming' | 'done' | 'error' | 'aborted';
  requestId?: string;          // UUID - for request tracking
}
```

### Attachment

```typescript
export interface Attachment {
  name: string;                // Original filename
  url: string;                 // Public URL to uploaded file
  contentType: string;         // MIME type
  size?: number;               // File size in bytes
}
```

---

## Error Types & Codes

**New Error Surface: "upload"**
- `unauthorized:upload` - User not authenticated
- `bad_request:upload` - Invalid file or parameters
- `forbidden:upload` - Permission denied
- `internal_error:upload` - Server error during upload

**Error Response Format:**
```json
{
  "code": "<type>:<surface>",
  "message": "User-friendly message",
  "cause": "Technical cause (only shown to authenticated users for security)"
}
```

---

## Migration Guide

### For Existing Clients

**Breaking Change:** Parameter name changed from `id` to `conversationId`

**Before:**
```javascript
{
  "id": "conversation-uuid",
  "message": {...}
}
```

**After:**
```javascript
{
  "conversationId": "conversation-uuid",
  "message": {...}
}
```

### For Chat History Loading

The `getChatById()` and `getMessagesByChatId()` functions now use `conversationId` parameter:

**Before:**
```typescript
const chat = await getChatById({ id: chatId });
const messages = await getMessagesByChatId({ id: chatId });
```

**After:**
```typescript
const chat = await getChatById({ conversationId: chatId });
const messages = await getMessagesByChatId({ conversationId: chatId });
```

---

## Security Enhancements

### XSS Protection

**New sanitization utilities in `lib/utils.ts`:**

1. **`sanitizeText(text: string)`**
   - Removes script tags, event handlers, javascript: URLs
   - Safe for text content

2. **`sanitizeHtml(html: string)`**
   - Full HTML sanitization for rendered Markdown
   - Whitelists safe tags (p, h1-h6, code, pre, a, table, etc.)
   - Removes event handlers and dangerous attributes
   - Escapes javascript: and data: protocols

### File Upload Validation

- **Type checking**: Only JPEG, PNG, WebP, GIF, PDF allowed
- **Size limit**: Maximum 20MB per file
- **Filename sanitization**: UUID-based names prevent directory traversal
- **Authentication**: All uploads require user authentication

---

## Performance Improvements

### Database Indexes

1. **`idx_message_chat_status`** - Fast status-based queries for recovery
2. **`idx_message_chat_created`** - Efficient chronological ordering
3. **`idx_chat_user_created`** - Fast chat list loading per user

### Caching Strategy

- Message timestamps included for efficient incremental loading
- `hasMore` flag allows pagination without COUNT queries
- `lastMessageTimestamp` enables timestamp-based sync

---

## Next Steps & Roadmap

### Immediate (Implemented)
- ✅ Parameter consistency (conversationId)
- ✅ Message status tracking
- ✅ File upload endpoint
- ✅ Conversation recovery APIs
- ✅ XSS protection utilities
- ✅ Enhanced error types

### Near-term (Recommended)
- Frontend message status indicators
- Markdown rendering with sanitization
- Progressive message display (show status)
- Upload progress UI
- Connection recovery UI

### Future (Enterprise)
- Redis caching for session recovery
- Rate limiting per user/model
- Request deduplication
- Analytics & monitoring
- Webhook integrations
