const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Allow all origins for development
    methods: ["GET", "POST"],
  },
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 10000,
});

const rooms = new Map();

process.on("uncaughtException", (err) => {
  console.error(
    `[${new Date().toISOString()}] Uncaught Exception: ${err.message}`
  );
  console.error(err.stack);
});

app.get("/debug/rooms", (req, res) => {
  try {
    console.log(`[${new Date().toISOString()}] GET /debug/rooms requested`);
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
    console.error(
      `[${new Date().toISOString()}] Error in /debug/rooms: ${error.message}`
    );
    res.status(500).json({ error: "Internal server error" });
  }
});

io.on("connection", (socket) => {
  console.log(
    `[${new Date().toISOString()}] New socket connected: ${socket.id}`
  );

  socket.on("createRoom", ({ roomName, userName, totalDuration }) => {
    try {
      console.log(
        `Creating room: ${roomName} by ${userName}, duration: ${totalDuration}m`
      );
      const roomCode = Math.random().toString(36).substring(2, 10);
      const room = {
        roomCode,
        roomName,
        totalDuration,
        questionDuration: 5, // Default Q&A duration
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
      console.log(`Room created: ${roomCode}, state:`, JSON.stringify(room));
    } catch (err) {
      console.error(`Error in createRoom: ${err.message}`);
      socket.emit("error", "Failed to create room");
    }
  });

  socket.on("joinRoom", ({ roomCode, userName }) => {
    try {
      console.log(
        `[${new Date().toISOString()}] Join room request for ${roomCode} by ${userName} (socket: ${
          socket.id
        })`
      );
      const room = rooms.get(roomCode);
      if (!room) {
        console.error(`Room ${roomCode} does not exist`);
        socket.emit("error", "Room does not exist");
        return;
      }
      if (room.isLocked) {
        console.error(`Room ${roomCode} is locked`);
        socket.emit("error", "Room is locked");
        return;
      }
      const existingParticipant = room.participants.find(
        (p) => p.name === userName
      );
      if (existingParticipant) {
        console.log(
          `User ${userName} already in room ${roomCode}, updating socket ID`
        );
        existingParticipant.id = socket.id;
        existingParticipant.isActive = true;
        socket.join(roomCode);
        socket.emit("updateRoomState", room);
        room.lastUpdated = Date.now();
        io.to(roomCode).emit("updateRoomState", room);
        console.log(`Room state after join:`, JSON.stringify(room));
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
      console.log(`User ${userName} joined room ${roomCode}`);
      console.log(`Room state after join:`, JSON.stringify(room));
    } catch (err) {
      console.error(`Error in joinRoom: ${err.message}`);
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
      console.error(`Error in addCheckpoint: ${err.message}`);
      socket.emit("error", "Failed to add checkpoint");
    }
  });

  socket.on("removeCheckpoint", ({ id }) => {
    try {
      const roomCode = Array.from(socket.rooms)[1];
      console.log(`Removing checkpoint: ${id} in room ${roomCode}`);
      const room = rooms.get(roomCode);
      if (!room) return;
      room.checkpoints = room.checkpoints.filter((cp) => cp.id !== id);
      room.lastUpdated = Date.now();
      io.to(roomCode).emit("updateRoomState", room);
      console.log(`Checkpoint removed, room state:`, JSON.stringify(room));
    } catch (err) {
      console.error(`Error in removeCheckpoint: ${err.message}`);
      socket.emit("error", "Failed to remove checkpoint");
    }
  });

  socket.on("startTimer", ({ roomCode }) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) return;
      const participant = room.participants.find((p) => p.id === socket.id);
      if (!participant || !participant.isHost) {
        console.error(
          `Non-host ${socket.id} attempted to start timer for room ${roomCode}`
        );
        socket.emit("error", "Only host can start timer");
        return;
      }
      console.log(`Starting timer for room ${roomCode}, phase: ${room.phase}`);
      if (room.isRunning) return;
      room.isRunning = true;
      const warningSeconds = [60, 30]; // Server-side warning times
      room.timer = setInterval(() => {
        room.remainingTime = Math.max(0, room.remainingTime - 1);
        room.lastUpdated = Date.now();

        // Check warnings
        warningSeconds.forEach((warningTime) => {
          if (room.remainingTime === warningTime) {
            console.log(
              `Emitting warning for ${roomCode}: ${room.remainingTime}s remaining`
            );
            io.to(roomCode).emit("timerWarning", {
              remainingTime: room.remainingTime,
              phase: room.phase,
            });
          }
        });

        // Check phase transition
        if (room.remainingTime <= 0 && room.phase === "presentation") {
          console.log(`Transitioning to Q&A for room ${roomCode}`);
          room.phase = "questions";
          room.remainingTime = room.questionDuration * 60;
          io.to(roomCode).emit("phaseTransition", { phase: "questions" });
        } else if (room.remainingTime <= 0 && room.phase === "questions") {
          console.log(`Timer completed for room ${roomCode}`);
          room.phase = "completed";
          room.isRunning = false;
          clearInterval(room.timer);
          io.to(roomCode).emit("timerCompleted");
        }

        io.to(roomCode).emit("updateRoomState", room);
      }, 1000);
      io.to(roomCode).emit("updateRoomState", room);
      console.log(`Timer started, room state:`, JSON.stringify(room));
    } catch (err) {
      console.error(`Error in startTimer: ${err.message}`);
      socket.emit("error", "Failed to start timer");
    }
  });

  socket.on("pauseTimer", ({ roomCode }) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) return;
      const participant = room.participants.find((p) => p.id === socket.id);
      if (!participant || !participant.isHost) {
        console.error(
          `Non-host ${socket.id} attempted to pause timer for room ${roomCode}`
        );
        socket.emit("error", "Only host can pause timer");
        return;
      }
      console.log(`Pausing timer for room ${roomCode}`);
      if (!room.isRunning) return;
      clearInterval(room.timer);
      room.isRunning = false;
      room.lastUpdated = Date.now();
      io.to(roomCode).emit("updateRoomState", room);
      console.log(`Timer paused, room state:`, JSON.stringify(room));
    } catch (err) {
      console.error(`Error in pauseTimer: ${err.message}`);
      socket.emit("error", "Failed to pause timer");
    }
  });

  socket.on("toggleReady", ({ roomCode }) => {
    try {
      console.log(
        `Toggling ready status in room ${roomCode} for socket ${socket.id}`
      );
      const room = rooms.get(roomCode);
      if (!room) {
        console.error(`Room ${roomCode} not found`);
        socket.emit("error", "Room not found");
        return;
      }
      const participant = room.participants.find((p) => p.id === socket.id);
      if (participant) {
        participant.isReady = !participant.isReady;
        console.log(
          `User ${participant.name} is now ${
            participant.isReady ? "ready" : "not ready"
          }`
        );
        room.lastUpdated = Date.now();
        io.to(roomCode).emit("updateRoomState", room);
        console.log(`Room state after toggleReady:`, JSON.stringify(room));
      } else {
        console.error(
          `Participant with socket ${socket.id} not found in room ${roomCode}`
        );
        socket.emit("error", "Participant not found");
      }
    } catch (err) {
      console.error(`Error in toggleReady: ${err.message}`);
      socket.emit("error", "Failed to toggle ready status");
    }
  });

  socket.on("updateDuration", ({ roomCode, minutes, phase }) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) return;
      const participant = room.participants.find((p) => p.id === socket.id);
      if (!participant || !participant.isHost) {
        console.error(
          `Non-host ${socket.id} attempted to update duration for room ${roomCode}`
        );
        socket.emit("error", "Only host can update duration");
        return;
      }

      // Ensure minutes is a number and within valid range
      const validMinutes = Math.max(
        1,
        Math.min(phase === "questions" ? 30 : 60, Number(minutes))
      );

      console.log(`Current room state:`, {
        totalDuration: room.totalDuration,
        questionDuration: room.questionDuration,
        phase: room.phase,
        remainingTime: room.remainingTime,
      });

      if (phase === "questions") {
        console.log(
          `Updating Q&A duration from ${room.questionDuration} to ${validMinutes}`
        );
        room.questionDuration = validMinutes;
        // Update remaining time if we're in Q&A phase
        if (room.phase === "questions") {
          room.remainingTime = validMinutes * 60;
        }
      } else {
        console.log(
          `Updating presentation duration from ${room.totalDuration} to ${validMinutes}`
        );
        room.totalDuration = validMinutes;
        // Update remaining time if we're in presentation phase
        if (room.phase === "presentation") {
          room.remainingTime = validMinutes * 60;
        }
      }

      room.lastUpdated = Date.now();
      console.log(`Updated room state:`, {
        totalDuration: room.totalDuration,
        questionDuration: room.questionDuration,
        phase: room.phase,
        remainingTime: room.remainingTime,
      });

      io.to(roomCode).emit("updateRoomState", room);
    } catch (err) {
      console.error(`Error in updateDuration: ${err.message}`);
      socket.emit("error", "Failed to update duration");
    }
  });

  socket.on("skipToQuestions", ({ roomCode }) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) return;
      const participant = room.participants.find((p) => p.id === socket.id);
      if (!participant || !participant.isHost) {
        console.error(
          `Non-host ${socket.id} attempted to skip to Q&A for room ${roomCode}`
        );
        socket.emit("error", "Only host can skip to Q&A");
        return;
      }
      console.log(`Skipping to Q&A for room ${roomCode}`);
      if (room.phase !== "presentation") return;
      room.phase = "questions";
      room.remainingTime = room.questionDuration * 60 || 5 * 60;
      room.lastUpdated = Date.now();
      io.to(roomCode).emit("phaseTransition", { phase: "questions" });
      io.to(roomCode).emit("updateRoomState", room);
      console.log(`Skipped to Q&A, room state:`, JSON.stringify(room));
    } catch (err) {
      console.error(`Error in skipToQuestions: ${err.message}`);
      socket.emit("error", "Failed to skip to Q&A");
    }
  });

  // Add new socket event handler for resetting room phase
  socket.on("resetRoomPhase", ({ roomCode }) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) return;
      const participant = room.participants.find((p) => p.id === socket.id);
      if (!participant || !participant.isHost) {
        console.error(
          `Non-host ${socket.id} attempted to reset room phase for room ${roomCode}`
        );
        socket.emit("error", "Only host can reset room phase");
        return;
      }
      console.log(`Resetting room phase for room ${roomCode}`);
      room.phase = "presentation";
      room.remainingTime = room.totalDuration * 60;
      room.lastUpdated = Date.now();
      io.to(roomCode).emit("phaseTransition", { phase: "presentation" });
      io.to(roomCode).emit("updateRoomState", room);
      console.log(`Reset room phase, room state:`, JSON.stringify(room));
    } catch (err) {
      console.error(`Error in resetRoomPhase: ${err.message}`);
      socket.emit("error", "Failed to reset room phase");
    }
  });

  socket.on("toggleLock", ({ roomCode }) => {
    try {
      const room = rooms.get(roomCode);
      if (!room) return;
      const participant = room.participants.find((p) => p.id === socket.id);
      if (!participant || !participant.isHost) {
        console.error(
          `Non-host ${socket.id} attempted to toggle lock for room ${roomCode}`
        );
        socket.emit("error", "Only host can toggle lock");
        return;
      }
      console.log(`Toggling lock for room ${roomCode}`);
      room.isLocked = !room.isLocked;
      room.lastUpdated = Date.now();
      console.log(
        `Room ${roomCode} is now ${room.isLocked ? "locked" : "unlocked"}`
      );
      io.to(roomCode).emit("updateRoomState", room);
      console.log(`Room state after toggleLock:`, JSON.stringify(room));
    } catch (err) {
      console.error(`Error in toggleLock: ${err.message}`);
      socket.emit("error", "Failed to toggle lock");
    }
  });

  socket.on("disconnect", () => {
    try {
      console.log(
        `[${new Date().toISOString()}] Socket disconnected: ${socket.id}`
      );
      for (const [roomCode, room] of rooms) {
        const participant = room.participants.find((p) => p.id === socket.id);
        if (participant) {
          // Don't mark as inactive immediately, wait for a grace period
          const disconnectTimeout = setTimeout(() => {
            if (!socket.connected) {
              participant.isActive = false;
              console.log(
                `Marked participant ${participant.name} as inactive in room ${roomCode} after timeout`
              );
              room.lastUpdated = Date.now();
              io.to(roomCode).emit("updateRoomState", room);
            }
          }, 10000); // 10 second grace period

          // Store the timeout ID on the socket for cleanup
          socket.disconnectTimeout = disconnectTimeout;
        }
      }
    } catch (err) {
      console.error(`Error in disconnect: ${err.message}`);
    }
  });

  socket.on("connect", () => {
    // Clear any pending disconnect timeouts
    if (socket.disconnectTimeout) {
      clearTimeout(socket.disconnectTimeout);
      socket.disconnectTimeout = null;
    }
  });
});

httpServer.listen(3001, "0.0.0.0", () => {
  console.log("Socket.IO server running on http://0.0.0.0:3001");
});
