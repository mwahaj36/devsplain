
package com.enterprise.system;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.List;
import java.util.stream.Collectors;

public class ConnectionManager {

    private final ConcurrentHashMap<String, Connection> activeConnections;
    private final AtomicInteger connectionCounter;
    private final int maxConnections;

    public ConnectionManager(int maxConnections) {
        this.maxConnections = maxConnections;
        this.activeConnections = new ConcurrentHashMap<>();
        this.connectionCounter = new AtomicInteger(0);
    }

    public synchronized Connection establishConnection(String clientId) throws Exception {
        if (activeConnections.containsKey(clientId)) {
            return activeConnections.get(clientId);
        }
        if (connectionCounter.get() >= maxConnections) {
            throw new Exception("Maximum connection limit reached");
        }
        Connection newConn = new Connection(clientId, System.currentTimeMillis());
        activeConnections.put(clientId, newConn);
        connectionCounter.incrementAndGet();
        return newConn;
    }

    public void terminateConnection(String clientId) {
        if (activeConnections.remove(clientId) != null) {
            connectionCounter.decrementAndGet();
        }
    }

    public List<Connection> getStaleConnections(long thresholdMillis) {
        long now = System.currentTimeMillis();
        return activeConnections.values().stream()
                .filter(c -> (now - c.getLastActiveTime()) > thresholdMillis)
                .collect(Collectors.toList());
    }
    public static class Connection {
        private final String clientId;
        private long lastActiveTime;
        public Connection(String clientId, long lastActiveTime) {
            this.clientId = clientId;
            this.lastActiveTime = lastActiveTime;
        }
        public String getClientId() { return clientId; }
        public long getLastActiveTime() { return lastActiveTime; }
        public void updateActiveTime() { this.lastActiveTime = System.currentTimeMillis(); }
    }
}
