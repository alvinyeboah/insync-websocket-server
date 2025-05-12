require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createServer } = require("http");
const { Server } = require("socket.io");

const app = express();
const port = process.env.PORT || 3001;

// Enable CORS
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST"],
    credentials: true,
  })
);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 10000,
});

const rooms = new Map();

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Debug endpoint
app.get("/debug/rooms", (req, res) => {
  try {
    const roomsData = Array.from(rooms.entries()).map(([roomCode, room]) => ({
      roomCode,
      roomName: room.roomName,
      totalDuration: room.totalDuration,
      remainingTime: room.remainingTime,
      phase: room.phase,
      isRunning: room.isRunning,
      isLocked: room.isLocked,
      participants: room.participants,
      checkpoints: room.checkpoints,
      lastUpdated: room.lastUpdated,
    }));
    res.json(roomsData);
  } catch (error) {
    console.error("Error in /debug/rooms:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

io.on("connection", (socket) => {
  console.log(`New socket connected: ${socket.id}`);

  socket.on("createRoom", ({ roomName, userName, totalDuration }) => {
    try {
      const roomCode = Math.random().toString(36).substring(2, 10);
      const room = {
        roomCode,
        roomName,
        totalDuration,
        questionDuration: 5,
        remainingTime: totalDuration * 60,
        phase: "presentation",
        isRunning: false,
        isLocked: false,
        participants: [
          {
            id: socket.id,
            name: userName,
            isReady: false,
            isHost: true,
            isActive: true,
          },
        ],
        checkpoints: [],
        lastUpdated: Date.now(),
      };
      rooms.set(roomCode, room);
      socket.join(roomCode);
      socket.emit("roomCreated", { roomCode });
      socket.emit("updateRoomState", room);
    } catch (err) {
      console.error("Error in createRoom:", err);
      socket.emit("error", "Failed to create room");
    }
  });

  socket.on("joinRoom", ({ roomCode, userName }) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) {
        socket.emit("error", "Room does not exist");
        return;
      }
      if (room.isLocked) {
        socket.emit("error", "Room is locked");
        return;
      }
      const existingParticipant = room.participants.find(
        (p) => p.name === userName
      );
      if (existingParticipant) {
        existingParticipant.id = socket.id;
        existingParticipant.isActive = true;
        socket.join(roomCode);
        socket.emit("updateRoomState", room);
        room.lastUpdated = Date.now();
        io.to(roomCode).emit("updateRoomState", room);
        return;
      }
      room.participants.push({
        id: socket.id,
        name: userName,
        isReady: false,
        isHost: false,
        isActive: true,
      });
      socket.join(roomCode);
      socket.emit("updateRoomState", room);
      room.lastUpdated = Date.now();
      io.to(roomCode).emit("updateRoomState", room);
    } catch (err) {
      console.error("Error in joinRoom:", err);
      socket.emit("error", "Failed to join room");
    }
  });

  socket.on("addCheckpoint", ({ name, timeInSeconds, note }) => {
    try {
      const roomCode = Array.from(socket.rooms)[1];
      const room = rooms.get(roomCode);
      if (!room) return;
      room.checkpoints.push({
        id: Date.now().toString(),
        name,
        timeInSeconds,
        note,
        reached: false,
      });
      room.lastUpdated = Date.now();
      io.to(roomCode).emit("updateRoomState", room);
    } catch (err) {
      console.error("Error in addCheckpoint:", err);
      socket.emit("error", "Failed to add checkpoint");
    }
  });

  socket.on("removeCheckpoint", ({ id }) => {
    try {
      const roomCode = Array.from(socket.rooms)[1];
      const room = rooms.get(roomCode);
      if (!room) return;
      room.checkpoints = room.checkpoints.filter((cp) => cp.id !== id);
      room.lastUpdated = Date.now();
      io.to(roomCode).emit("updateRoomState", room);
    } catch (err) {
      console.error("Error in removeCheckpoint:", err);
      socket.emit("error", "Failed to remove checkpoint");
    }
  });

  socket.on("startTimer", ({ roomCode }) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) return;
      const participant = room.participants.find((p) => p.id === socket.id);
      if (!participant || !participant.isHost) {
        socket.emit("error", "Only host can start timer");
        return;
      }
      if (room.isRunning) return;
      room.isRunning = true;
      const warningSeconds = [60, 30];
      room.timer = setInterval(() => {
        room.remainingTime = Math.max(0, room.remainingTime - 1);
        room.lastUpdated = Date.now();

        warningSeconds.forEach((warningTime) => {
          if (room.remainingTime === warningTime) {
            io.to(roomCode).emit("timerWarning", {
              remainingTime: room.remainingTime,
              phase: room.phase,
            });
          }
        });

        if (room.remainingTime <= 0 && room.phase === "presentation") {
          room.phase = "questions";
          room.remainingTime = room.questionDuration * 60;
          io.to(roomCode).emit("phaseTransition", { phase: "questions" });
        } else if (room.remainingTime <= 0 && room.phase === "questions") {
          room.phase = "completed";
          room.isRunning = false;
          clearInterval(room.timer);
          io.to(roomCode).emit("timerCompleted");
        }

        io.to(roomCode).emit("updateRoomState", room);
      }, 1000);
      io.to(roomCode).emit("updateRoomState", room);
    } catch (err) {
      console.error("Error in startTimer:", err);
      socket.emit("error", "Failed to start timer");
    }
  });

  socket.on("pauseTimer", ({ roomCode }) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) return;
      const participant = room.participants.find((p) => p.id === socket.id);
      if (!participant || !participant.isHost) {
        socket.emit("error", "Only host can pause timer");
        return;
      }
      if (!room.isRunning) return;
      clearInterval(room.timer);
      room.isRunning = false;
      room.lastUpdated = Date.now();
      io.to(roomCode).emit("updateRoomState", room);
    } catch (err) {
      console.error("Error in pauseTimer:", err);
      socket.emit("error", "Failed to pause timer");
    }
  });

  socket.on("toggleReady", ({ roomCode }) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) {
        socket.emit("error", "Room not found");
        return;
      }
      const participant = room.participants.find((p) => p.id === socket.id);
      if (participant) {
        participant.isReady = !participant.isReady;
        room.lastUpdated = Date.now();
        io.to(roomCode).emit("updateRoomState", room);
      } else {
        socket.emit("error", "Participant not found");
      }
    } catch (err) {
      console.error("Error in toggleReady:", err);
      socket.emit("error", "Failed to toggle ready status");
    }
  });

  socket.on("updateDuration", ({ roomCode, minutes }) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) return;
      const participant = room.participants.find((p) => p.id === socket.id);
      if (!participant || !participant.isHost) {
        socket.emit("error", "Only host can update duration");
        return;
      }
      if (room.phase === "presentation") {
        room.totalDuration = minutes;
        if (!room.isRunning) {
          room.remainingTime = minutes * 60;
        }
      } else if (room.phase === "questions") {
        room.questionDuration = minutes;
        if (!room.isRunning) {
          room.remainingTime = minutes * 60;
        }
      }
      room.lastUpdated = Date.now();
      io.to(roomCode).emit("updateRoomState", room);
    } catch (err) {
      console.error("Error in updateDuration:", err);
      socket.emit("error", "Failed to update duration");
    }
  });

  socket.on("skipToQuestions", ({ roomCode }) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) return;
      const participant = room.participants.find((p) => p.id === socket.id);
      if (!participant || !participant.isHost) {
        socket.emit("error", "Only host can skip to Q&A");
        return;
      }
      if (room.phase !== "presentation") return;
      room.phase = "questions";
      room.remainingTime = room.questionDuration * 60 || 5 * 60;
      room.lastUpdated = Date.now();
      io.to(roomCode).emit("phaseTransition", { phase: "questions" });
      io.to(roomCode).emit("updateRoomState", room);
    } catch (err) {
      console.error("Error in skipToQuestions:", err);
      socket.emit("error", "Failed to skip to Q&A");
    }
  });

  socket.on("toggleLock", ({ roomCode }) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) return;
      const participant = room.participants.find((p) => p.id === socket.id);
      if (!participant || !participant.isHost) {
        socket.emit("error", "Only host can toggle lock");
        return;
      }
      room.isLocked = !room.isLocked;
      room.lastUpdated = Date.now();
      io.to(roomCode).emit("updateRoomState", room);
    } catch (err) {
      console.error("Error in toggleLock:", err);
      socket.emit("error", "Failed to toggle lock");
    }
  });

  socket.on("disconnect", () => {
    try {
      for (const [roomCode, room] of rooms) {
        const participant = room.participants.find((p) => p.id === socket.id);
        if (participant) {
          participant.isActive = false;
          room.lastUpdated = Date.now();
          io.to(roomCode).emit("updateRoomState", room);
        }
      }
    } catch (err) {
      console.error("Error in disconnect:", err);
    }
  });
});

httpServer.listen(port, () => {
  console.log(`WebSocket server running on port ${port}`);
});
