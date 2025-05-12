# InSync WebSocket Server

This is the WebSocket server for the InSync application, handling real-time communication between users in presentation rooms.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file based on `.env.example`:
```bash
cp .env.example .env
```

3. Update the environment variables in `.env`:
- `PORT`: The port the server will run on (default: 3001)
- `FRONTEND_URL`: The URL of your frontend application

## Development

Run the development server:
```bash
npm run dev
```

## Production

Run the production server:
```bash
npm start
```

## Deployment to Railway

1. Create a new project on [Railway](https://railway.app/)
2. Connect your GitHub repository
3. Add the following environment variables in Railway:
   - `PORT`: 3001
   - `FRONTEND_URL`: Your frontend URL (e.g., https://your-app.vercel.app)

4. Deploy the project

## API Endpoints

- `GET /health`: Health check endpoint
- `GET /debug/rooms`: Debug endpoint to list all active rooms

## WebSocket Events

The server handles the following WebSocket events:

- `createRoom`: Create a new presentation room
- `joinRoom`: Join an existing room
- `addCheckpoint`: Add a checkpoint to the presentation
- `removeCheckpoint`: Remove a checkpoint
- `startTimer`: Start the presentation timer
- `pauseTimer`: Pause the presentation timer
- `toggleReady`: Toggle participant ready status
- `updateDuration`: Update presentation duration
- `skipToQuestions`: Skip to Q&A phase
- `toggleLock`: Toggle room lock status 