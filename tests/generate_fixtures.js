const fs = require('fs');
const path = require('path');

const targetDir = path.join(__dirname, 'fixtures');
if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
}

const languages = {
    c: {
        ext: '.c',
        code: `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_USERS 100

typedef struct {
    int id;
    char name[50];
    int isActive;
} User;

User users[MAX_USERS];
int userCount = 0;

void initSystem() {
    userCount = 0;
    memset(users, 0, sizeof(users));
}

int addUser(int id, const char* name) {
    if (userCount >= MAX_USERS) return -1;
    for (int i = 0; i < userCount; i++) {
        if (users[i].id == id) return -2;
    }
    users[userCount].id = id;
    strncpy(users[userCount].name, name, 49);
    users[userCount].isActive = 1;
    userCount++;
    return 0;
}

void printActiveUsers() {
    printf("Active Users:\\n");
    for (int i = 0; i < userCount; i++) {
        if (users[i].isActive) {
            printf("- %d: %s\\n", users[i].id, users[i].name);
        }
    }
}

int main() {
    initSystem();
    addUser(1, "Alice");
    addUser(2, "Bob");
    printActiveUsers();
    return 0;
}
`
    },
    cpp: {
        ext: '.cpp',
        code: `
#include <iostream>
#include <vector>
#include <string>
#include <memory>
#include <algorithm>

class Entity {
protected:
    int id;
    std::string name;
public:
    Entity(int id, std::string name) : id(id), name(name) {}
    virtual ~Entity() = default;
    virtual void process() = 0;
    int getId() const { return id; }
    std::string getName() const { return name; }
};

class Player : public Entity {
private:
    int health;
    int score;
public:
    Player(int id, std::string name) : Entity(id, name), health(100), score(0) {}
    void process() override {
        if (health > 0) {
            score += 10;
        }
    }
    void takeDamage(int amount) {
        health = std::max(0, health - amount);
    }
    bool isAlive() const { return health > 0; }
};

class GameManager {
private:
    std::vector<std::shared_ptr<Entity>> entities;
public:
    void addEntity(std::shared_ptr<Entity> entity) {
        entities.push_back(entity);
    }
    void gameLoop() {
        for (auto& entity : entities) {
            entity->process();
        }
    }
};

int main() {
    GameManager gm;
    auto p1 = std::make_shared<Player>(1, "Hero");
    gm.addEntity(p1);
    gm.gameLoop();
    return 0;
}
`
    },
    cs: {
        ext: '.cs',
        code: `
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace GameEngine
{
    public abstract class GameObject
    {
        public int Id { get; set; }
        public string Name { get; set; }
        public bool IsActive { get; set; } = true;

        protected GameObject(int id, string name)
        {
            Id = id;
            Name = name;
        }

        public abstract Task UpdateAsync();
    }

    public class Player : GameObject
    {
        public int Health { get; private set; } = 100;

        public Player(int id, string name) : base(id, name) { }

        public override async Task UpdateAsync()
        {
            if (Health > 0)
            {
                await Task.Delay(10);
                Health -= 1; 
            }
        }
    }

    public class Engine
    {
        private readonly List<GameObject> _objects = new List<GameObject>();

        public void Register(GameObject obj)
        {
            if (!_objects.Any(o => o.Id == obj.Id))
            {
                _objects.Add(obj);
            }
        }

        public async Task RunLoopAsync()
        {
            var activeObjects = _objects.Where(o => o.IsActive).ToList();
            var updateTasks = activeObjects.Select(o => o.UpdateAsync());
            await Task.WhenAll(updateTasks);
        }
    }
}
`
    },
    py: {
        ext: '.py',
        code: `
import asyncio
from typing import List, Optional, Dict
from dataclasses import dataclass

@dataclass
class UserInfo:
    user_id: int
    username: str
    is_active: bool = True

class UserManager:
    def __init__(self):
        self._users: Dict[int, UserInfo] = {}
        self._lock = asyncio.Lock()

    async def add_user(self, user_id: int, username: str) -> bool:
        async with self._lock:
            if user_id in self._users:
                return False
            self._users[user_id] = UserInfo(user_id=user_id, username=username)
            return True

    async def get_active_users(self) -> List[UserInfo]:
        async with self._lock:
            return [user for user in self._users.values() if user.is_active]

    async def deactivate_user(self, user_id: int) -> bool:
        async with self._lock:
            if user_id not in self._users:
                return False
            self._users[user_id].is_active = False
            return True

async def main():
    manager = UserManager()
    await manager.add_user(1, "alice")
    await manager.add_user(2, "bob")
    active = await manager.get_active_users()
    for u in active:
        print(f"Active: {u.username}")
    await manager.deactivate_user(1)

if __name__ == "__main__":
    asyncio.run(main())
`
    },
    js: {
        ext: '.js',
        code: `
const EventEmitter = require('events');

class DataStore extends EventEmitter {
    constructor() {
        super();
        this.records = new Map();
        this.transactionActive = false;
        this.pendingChanges = [];
    }

    beginTransaction() {
        if (this.transactionActive) throw new Error("Transaction already active");
        this.transactionActive = true;
        this.pendingChanges = [];
        this.emit('transactionStart');
    }

    commit() {
        if (!this.transactionActive) throw new Error("No active transaction");
        for (const {key, value} of this.pendingChanges) {
            this.records.set(key, value);
        }
        this.transactionActive = false;
        this.pendingChanges = [];
        this.emit('transactionCommit');
    }

    rollback() {
        if (!this.transactionActive) throw new Error("No active transaction");
        this.transactionActive = false;
        this.pendingChanges = [];
        this.emit('transactionRollback');
    }

    set(key, value) {
        if (this.transactionActive) {
            this.pendingChanges.push({key, value});
        } else {
            this.records.set(key, value);
            this.emit('change', key, value);
        }
    }

    get(key) {
        if (this.transactionActive) {
            const pending = this.pendingChanges.find(p => p.key === key);
            if (pending) return pending.value;
        }
        return this.records.get(key);
    }
}

module.exports = DataStore;
`
    },
    ts: {
        ext: '.ts',
        code: `
export interface RequestPayload {
    id: string;
    timestamp: number;
    data: any;
}

export interface ResponsePayload {
    success: boolean;
    data?: any;
    error?: string;
}

export class ApiController {
    private endpoints: Map<string, Function>;

    constructor() {
        this.endpoints = new Map();
    }

    public registerEndpoint(path: string, handler: (req: RequestPayload) => Promise<ResponsePayload>): void {
        if (this.endpoints.has(path)) {
            throw new Error(\`Endpoint \${path} already registered\`);
        }
        this.endpoints.set(path, handler);
    }

    public async handleRequest(path: string, payload: RequestPayload): Promise<ResponsePayload> {
        try {
            const handler = this.endpoints.get(path);
            if (!handler) {
                return { success: false, error: 'Endpoint not found' };
            }
            const result = await handler(payload);
            return result;
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }
}

const api = new ApiController();
api.registerEndpoint('/ping', async (req) => {
    return { success: true, data: { pong: req.timestamp } };
});
`
    },
    jsx: {
        ext: '.jsx',
        code: `
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import PropTypes from 'prop-types';

const DataGrid = ({ url, columns, pageSize }) => {
    const [data, setData] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [page, setPage] = useState(0);

    const fetchData = useCallback(async () => {
        try {
            setLoading(true);
            const response = await fetch(\`\${url}?page=\${page}&size=\${pageSize}\`);
            if (!response.ok) throw new Error("Network error");
            const result = await response.json();
            setData(result.items);
            setError(null);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [url, page, pageSize]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const renderedHeaders = useMemo(() => {
        return (
            <tr>
                {columns.map(col => <th key={col.key}>{col.title}</th>)}
            </tr>
        );
    }, [columns]);

    if (error) return <div className="error">{error}</div>;
    if (loading) return <div className="spinner" />;

    return (
        <div className="data-grid-container">
            <table>
                <thead>{renderedHeaders}</thead>
                <tbody>
                    {data.map(row => (
                        <tr key={row.id}>
                            {columns.map(col => <td key={col.key}>{row[col.key]}</td>)}
                        </tr>
                    ))}
                </tbody>
            </table>
            <div className="pagination">
                <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>Prev</button>
                <span>Page {page + 1}</span>
                <button onClick={() => setPage(p => p + 1)}>Next</button>
            </div>
        </div>
    );
};

DataGrid.propTypes = {
    url: PropTypes.string.isRequired,
    columns: PropTypes.array.isRequired,
    pageSize: PropTypes.number
};

DataGrid.defaultProps = {
    pageSize: 10
};

export default DataGrid;
`
    },
    tsx: {
        ext: '.tsx',
        code: `
import React, { useState, useEffect } from 'react';

interface User {
    id: number;
    name: string;
    email: string;
    isActive: boolean;
}

interface UserListProps {
    apiEndpoint: string;
    onUserSelect?: (user: User) => void;
}

export const UserList: React.FC<UserListProps> = ({ apiEndpoint, onUserSelect }) => {
    const [users, setUsers] = useState<User[]>([]);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [filterActive, setFilterActive] = useState<boolean>(false);

    useEffect(() => {
        const loadUsers = async () => {
            setIsLoading(true);
            try {
                const res = await fetch(apiEndpoint);
                const data: User[] = await res.json();
                setUsers(data);
            } catch (e) {
                console.error("Failed to fetch users", e);
            } finally {
                setIsLoading(false);
            }
        };
        loadUsers();
    }, [apiEndpoint]);

    const filteredUsers = filterActive ? users.filter(u => u.isActive) : users;

    return (
        <div className="user-list">
            <header>
                <h2>User Management</h2>
                <label>
                    <input 
                        type="checkbox" 
                        checked={filterActive} 
                        onChange={(e) => setFilterActive(e.target.checked)} 
                    />
                    Show only active
                </label>
            </header>
            {isLoading ? (
                <p>Loading users...</p>
            ) : (
                <ul>
                    {filteredUsers.map(user => (
                        <li 
                            key={user.id} 
                            onClick={() => onUserSelect && onUserSelect(user)}
                            className={user.isActive ? 'active' : 'inactive'}
                        >
                            <strong>{user.name}</strong> ({user.email})
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};
`
    },
    java: {
        ext: '.java',
        code: `
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
`
    },
    go: {
        ext: '.go',
        code: `
package worker

import (
	"context"
	"fmt"
	"sync"
	"time"
)

type Job interface {
	Execute(ctx context.Context) error
	ID() string
}

type Pool struct {
	workers int
	jobs    chan Job
	wg      sync.WaitGroup
	ctx     context.Context
	cancel  context.CancelFunc
}

func NewPool(workers int, buffer int) *Pool {
	ctx, cancel := context.WithCancel(context.Background())
	return &Pool{
		workers: workers,
		jobs:    make(chan Job, buffer),
		ctx:     ctx,
		cancel:  cancel,
	}
}

func (p *Pool) Start() {
	for i := 0; i < p.workers; i++ {
		p.wg.Add(1)
		go p.worker(i)
	}
}

func (p *Pool) worker(id int) {
	defer p.wg.Done()
	for {
		select {
		case <-p.ctx.Done():
			fmt.Printf("Worker %d shutting down\\n", id)
			return
		case job, ok := <-p.jobs:
			if !ok {
				return
			}
			fmt.Printf("Worker %d executing job %s\\n", id, job.ID())
			err := job.Execute(p.ctx)
			if err != nil {
				fmt.Printf("Error executing job %s: %v\\n", job.ID(), err)
			}
		}
	}
}

func (p *Pool) Submit(j Job) bool {
	select {
	case p.jobs <- j:
		return true
	case <-time.After(time.Second):
		return false
	}
}

func (p *Pool) Stop() {
	p.cancel()
	close(p.jobs)
	p.wg.Wait()
}
`
    },
    rust: {
        ext: '.rs',
        code: `
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Task {
    pub id: u32,
    pub payload: String,
    pub is_completed: bool,
}

pub struct TaskScheduler {
    tasks: Arc<Mutex<HashMap<u32, Task>>>,
}

impl TaskScheduler {
    pub fn new() -> Self {
        TaskScheduler {
            tasks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn add_task(&self, id: u32, payload: String) {
        let mut map = self.tasks.lock().unwrap();
        map.insert(id, Task { id, payload, is_completed: false });
    }

    pub fn process_all(&self) {
        let tasks_clone = Arc::clone(&self.tasks);
        thread::spawn(move || {
            let mut map = tasks_clone.lock().unwrap();
            for (id, task) in map.iter_mut() {
                if !task.is_completed {
                    println!("Processing task {}", id);
                    thread::sleep(Duration::from_millis(100));
                    task.is_completed = true;
                }
            }
        }).join().unwrap();
    }

    pub fn get_completed(&self) -> Vec<Task> {
        let map = self.tasks.lock().unwrap();
        map.values()
            .filter(|t| t.is_completed)
            .cloned()
            .collect()
    }
}
`
    },
    ruby: {
        ext: '.rb',
        code: `
module Enterprise
  module Billing
    class InvoiceProcessor
      attr_reader :invoices, :processed_count

      def initialize
        @invoices = []
        @processed_count = 0
      end

      def add_invoice(id, amount, customer_id)
        @invoices << {
          id: id,
          amount: amount,
          customer_id: customer_id,
          status: :pending,
          created_at: Time.now
        }
      end

      def process_pending
        @invoices.each do |invoice|
          next unless invoice[:status] == :pending

          begin
            charge_customer(invoice[:customer_id], invoice[:amount])
            invoice[:status] = :paid
            @processed_count += 1
          rescue => e
            puts "Failed to process invoice #{invoice[:id]}: #{e.message}"
            invoice[:status] = :failed
          end
        end
      end

      def report
        paid = @invoices.select { |i| i[:status] == :paid }.sum { |i| i[:amount] }
        failed = @invoices.select { |i| i[:status] == :failed }.count
        { total_paid: paid, failed_count: failed, processed: @processed_count }
      end

      private

      def charge_customer(customer_id, amount)
        raise "Invalid amount" if amount <= 0
        sleep 0.1 
      end
    end
  end
end
`
    },
    php: {
        ext: '.php',
        code: `
<?php

namespace App\\Services;

use Exception;
use PDO;

class DatabaseMigrator {
    private PDO $connection;
    private array $migrationsPath;

    public function __construct(PDO $connection, array $paths) {
        $this->connection = $connection;
        $this->migrationsPath = $paths;
    }

    public function runMigrations(): void {
        $this->connection->beginTransaction();
        try {
            $executed = $this->getExecutedMigrations();
            foreach ($this->migrationsPath as $path) {
                if (!in_array($path, $executed)) {
                    $this->executeFile($path);
                    $this->logMigration($path);
                }
            }
            $this->connection->commit();
        } catch (Exception $e) {
            $this->connection->rollBack();
            error_log("Migration failed: " . $e->getMessage());
            throw $e;
        }
    }

    private function getExecutedMigrations(): array {
        $stmt = $this->connection->query("SELECT filename FROM migrations");
        return $stmt ? $stmt->fetchAll(PDO::FETCH_COLUMN) : [];
    }

    private function executeFile(string $path): void {
        if (!file_exists($path)) {
            throw new Exception("Migration file not found: $path");
        }
        $sql = file_get_contents($path);
        $this->connection->exec($sql);
    }

    private function logMigration(string $path): void {
        $stmt = $this->connection->prepare("INSERT INTO migrations (filename, executed_at) VALUES (?, NOW())");
        $stmt->execute([$path]);
    }
}
`
    },
    swift: {
        ext: '.swift',
        code: `
import Foundation

public enum NetworkError: Error {
    case invalidURL
    case requestFailed(Int)
    case decodingFailed
}

public struct User: Codable, Identifiable {
    public let id: Int
    public let name: String
    public let email: String
}

public class APIClient {
    private let baseURL: String
    private let session: URLSession
    public init(baseURL: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }
    public func fetchUsers(completion: @escaping (Result<[User], NetworkError>) -> Void) {
        guard let url = URL(string: "\\(baseURL)/users") else {
            completion(.failure(.invalidURL))
            return
        }
        let task = session.dataTask(with: url) { data, response, error in
            if let httpResponse = response as? HTTPURLResponse, !(200...299).contains(httpResponse.statusCode) {
                completion(.failure(.requestFailed(httpResponse.statusCode)))
                return
            }
            guard let data = data else {
                completion(.failure(.decodingFailed))
                return
            }
            do {
                let decoder = JSONDecoder()
                let users = try decoder.decode([User].self, from: data)
                completion(.success(users))
            } catch {
                completion(.failure(.decodingFailed))
            }
        }
        task.resume()
    }
}
`
    },
    kotlin: {
        ext: '.kt',
        code: `
package com.example.ecommerce

import java.math.BigDecimal
import java.util.UUID

data class Product(val id: UUID, val name: String, val price: BigDecimal, var stock: Int)
data class CartItem(val product: Product, var quantity: Int)

class ShoppingCart {
    private val items = mutableListOf<CartItem>()

    fun addItem(product: Product, quantity: Int) {
        require(quantity > 0) { "Quantity must be positive" }
        require(product.stock >= quantity) { "Not enough stock" }

        val existing = items.find { it.product.id == product.id }
        if (existing != null) {
            existing.quantity += quantity
        } else {
            items.add(CartItem(product, quantity))
        }
        product.stock -= quantity
    }

    fun removeItem(productId: UUID) {
        val item = items.find { it.product.id == productId }
        if (item != null) {
            item.product.stock += item.quantity
            items.remove(item)
        }
    }

    fun calculateTotal(): BigDecimal {
        return items.fold(BigDecimal.ZERO) { acc, item ->
            acc.add(item.product.price.multiply(BigDecimal(item.quantity)))
        }
    }

    fun checkout(): Boolean {
        if (items.isEmpty()) return false
        items.clear()
        return true
    }
}
`
    },
    dart: {
        ext: '.dart',
        code: `
import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

class WeatherService {
  final String apiKey;
  final String baseUrl;
  WeatherService({required this.apiKey, this.baseUrl = 'https://api.weather.com'});

  Future<Map<String, dynamic>> getCurrentWeather(String city) async {
    final url = Uri.parse('$baseUrl/current?q=$city&appid=$apiKey');
    try {
      final response = await http.get(url).timeout(const Duration(seconds: 10));
      if (response.statusCode == 200) {
        return jsonDecode(response.body);
      } else {
        throw WeatherException('Failed to load weather: \${response.statusCode}');
      }
    } on TimeoutException {
      throw WeatherException('Request timed out');
    } catch (e) {
      throw WeatherException('Network error: $e');
    }
  }

  Stream<Map<String, dynamic>> weatherStream(String city, Duration interval) async* {
    while (true) {
      try {
        final data = await getCurrentWeather(city);
        yield data;
      } catch (e) {
        print('Stream error: $e');
      }
      await Future.delayed(interval);
    }
  }
}

class WeatherException implements Exception {
  final String message;
  WeatherException(this.message);
  @override
  String toString() => 'WeatherException: $message';
}
`
    },
    html: {
        ext: '.html',
        code: `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Enterprise Dashboard</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <nav class="sidebar">
        <div class="logo">CorpDash</div>
        <ul class="nav-links">
            <li><a href="#overview">Overview</a></li>
            <li><a href="#analytics">Analytics</a></li>
            <li><a href="#reports">Reports</a></li>
            <li><a href="#settings">Settings</a></li>
        </ul>
    </nav>
    <main class="content">
        <header class="topbar">
            <h1>Welcome back, Admin</h1>
            <div class="user-profile">
                <img src="avatar.png" alt="User Avatar">
                <button id="logoutBtn">Logout</button>
            </div>
        </header>
        <section class="metrics-grid">
            <div class="card metric">
                <h3>Total Revenue</h3>
                <p class="value">$124,500</p>
                <span class="trend positive">+12%</span>
            </div>
            <div class="card metric">
                <h3>Active Users</h3>
                <p class="value">45,210</p>
                <span class="trend negative">-2%</span>
            </div>
            <div class="card metric">
                <h3>Server Load</h3>
                <p class="value">68%</p>
                <progress value="68" max="100"></progress>
            </div>
        </section>
        <section class="data-table">
            <h2>Recent Transactions</h2>
            <table id="txTable">
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>Date</th>
                        <th>Amount</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    <tr><td>TX123</td><td>2023-10-01</td><td>$450.00</td><td>Completed</td></tr>
                    <tr><td>TX124</td><td>2023-10-02</td><td>$120.00</td><td>Pending</td></tr>
                </tbody>
            </table>
        </section>
    </main>
    <script src="app.js"></script>
</body>
</html>
`
    },
    css: {
        ext: '.css',
        code: `
:root {
    --primary-color: #2563eb;
    --secondary-color: #475569;
    --background: #f8fafc;
    --surface: #ffffff;
    --text-main: #0f172a;
    --text-muted: #64748b;
    --danger: #ef4444;
    --success: #22c55e;
    --radius: 8px;
    --shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);
}

body {
    margin: 0;
    font-family: 'Inter', system-ui, sans-serif;
    background-color: var(--background);
    color: var(--text-main);
    display: flex;
    min-height: 100vh;
}

.sidebar {
    width: 250px;
    background-color: var(--surface);
    border-right: 1px solid #e2e8f0;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
}

.nav-links {
    list-style: none;
    padding: 0;
    margin-top: 2rem;
}

.nav-links li a {
    display: block;
    padding: 0.75rem 1rem;
    color: var(--secondary-color);
    text-decoration: none;
    border-radius: var(--radius);
    transition: background 0.2s, color 0.2s;
}

.nav-links li a:hover {
    background-color: #eff6ff;
    color: var(--primary-color);
}

.card {
    background: var(--surface);
    border-radius: var(--radius);
    padding: 1.5rem;
    box-shadow: var(--shadow);
}

.metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 1.5rem;
    margin-bottom: 2rem;
}

.trend.positive { color: var(--success); }
.trend.negative { color: var(--danger); }

@media (max-width: 768px) {
    body { flex-direction: column; }
    .sidebar { width: 100%; border-right: none; border-bottom: 1px solid #e2e8f0; }
}
`
    },
    scss: {
        ext: '.scss',
        code: `
$primary: #3b82f6;
$danger: #ef4444;
$success: #10b981;
$bg-color: #f3f4f6;
$text-color: #1f2937;
$border-radius: 0.5rem;

@mixin flex-center {
  display: flex;
  align-items: center;
  justify-content: center;
}

@mixin card-shadow {
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
}

.app-container {
  background-color: $bg-color;
  color: $text-color;
  min-height: 100vh;
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;

  .header {
    background: white;
    padding: 1rem 2rem;
    display: flex;
    justify-content: space-between;
    @include card-shadow;

    .brand {
      font-size: 1.5rem;
      font-weight: bold;
      color: $primary;
    }

    nav {
      ul {
        display: flex;
        gap: 1.5rem;
        list-style: none;
        margin: 0;
        padding: 0;

        li a {
          text-decoration: none;
          color: $text-color;
          font-weight: 500;
          transition: color 0.3s;

          &:hover {
            color: $primary;
          }
        }
      }
    }
  }

  .main-content {
    padding: 2rem;
    max-width: 1200px;
    margin: 0 auto;

    .widget-panel {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1.5rem;

      .widget {
        background: white;
        border-radius: $border-radius;
        padding: 1.5rem;
        @include card-shadow;

        &.alert {
          border-left: 4px solid $danger;
        }

        &.ok {
          border-left: 4px solid $success;
        }
      }
    }
  }
}
`
    },
    vue: {
        ext: '.vue',
        code: `
<template>
  <div class="user-dashboard">
    <header class="dashboard-header">
      <h2>User Directory</h2>
      <div class="controls">
        <input v-model="searchQuery" type="text" placeholder="Search users..." />
        <select v-model="roleFilter">
          <option value="ALL">All Roles</option>
          <option value="ADMIN">Admin</option>
          <option value="USER">User</option>
        </select>
      </div>
    </header>

    <div v-if="loading" class="loader">Loading data...</div>
    <div v-else-if="error" class="error-msg">{{ error }}</div>
    <table v-else class="user-table">
      <thead>
        <tr>
          <th @click="sortBy('name')">Name ↕</th>
          <th @click="sortBy('email')">Email ↕</th>
          <th>Role</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="user in filteredAndSortedUsers" :key="user.id">
          <td>{{ user.name }}</td>
          <td>{{ user.email }}</td>
          <td>
            <span :class="['badge', user.role.toLowerCase()]">{{ user.role }}</span>
          </td>
          <td>
            <button @click="editUser(user)" class="btn-edit">Edit</button>
            <button @click="deleteUser(user.id)" class="btn-delete">Delete</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script>
export default {
  name: 'UserDashboard',
  data() {
    return {
      users: [],
      loading: true,
      error: null,
      searchQuery: '',
      roleFilter: 'ALL',
      sortKey: 'name',
      sortOrder: 1
    }
  },
  computed: {
    filteredAndSortedUsers() {
      let result = this.users;

      if (this.roleFilter !== 'ALL') {
        result = result.filter(u => u.role === this.roleFilter);
      }

      if (this.searchQuery) {
        const query = this.searchQuery.toLowerCase();
        result = result.filter(u => 
          u.name.toLowerCase().includes(query) || 
          u.email.toLowerCase().includes(query)
        );
      }

      result.sort((a, b) => {
        const valA = a[this.sortKey].toLowerCase();
        const valB = b[this.sortKey].toLowerCase();
        if (valA < valB) return -1 * this.sortOrder;
        if (valA > valB) return 1 * this.sortOrder;
        return 0;
      });

      return result;
    }
  },
  methods: {
    async fetchUsers() {
      try {
        const response = await fetch('/api/users');
        if (!response.ok) throw new Error('API Error');
        this.users = await response.json();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },
    sortBy(key) {
      if (this.sortKey === key) {
        this.sortOrder = this.sortOrder * -1;
      } else {
        this.sortKey = key;
        this.sortOrder = 1;
      }
    },
    deleteUser(id) {
      if (confirm('Are you sure?')) {
        this.users = this.users.filter(u => u.id !== id);
      }
    },
    editUser(user) {
      this.$emit('edit', user);
    }
  },
  mounted() {
    this.fetchUsers();
  }
}
</script>
`
    },
    svelte: {
        ext: '.svelte',
        code: `
<script>
    import { onMount } from 'svelte';
    import { fade, fly } from 'svelte/transition';

    export let endpoint = '/api/todos';
    let todos = [];
    let newTodoText = '';
    let filter = 'all';
    let isLoading = true;
    let errorMessage = '';

    onMount(async () => {
        try {
            const res = await fetch(endpoint);
            if (!res.ok) throw new Error('Failed to load todos');
            todos = await res.json();
        } catch (e) {
            errorMessage = e.message;
        } finally {
            isLoading = false;
        }
    });

    function addTodo() {
        if (!newTodoText.trim()) return;
        const newTodo = {
            id: Date.now(),
            text: newTodoText,
            completed: false
        };
        todos = [newTodo, ...todos];
        newTodoText = '';
    }

    function toggleTodo(id) {
        todos = todos.map(t => 
            t.id === id ? { ...t, completed: !t.completed } : t
        );
    }

    function deleteTodo(id) {
        todos = todos.filter(t => t.id !== id);
    }

    $: filteredTodos = todos.filter(t => {
        if (filter === 'active') return !t.completed;
        if (filter === 'completed') return t.completed;
        return true;
    });

    $: remainingCount = todos.filter(t => !t.completed).length;
</script>

<div class="todo-app">
    <h1>Svelte Task Manager</h1>
    {#if errorMessage}
        <div class="error" transition:fade>{errorMessage}</div>
    {/if}

    <form on:submit|preventDefault={addTodo}>
        <input 
            bind:value={newTodoText} 
            placeholder="What needs to be done?"
            disabled={isLoading}
        />
        <button type="submit" disabled={!newTodoText || isLoading}>Add</button>
    </form>

    <div class="filters">
        <button class:active={filter === 'all'} on:click={() => filter = 'all'}>All</button>
        <button class:active={filter === 'active'} on:click={() => filter = 'active'}>Active</button>
        <button class:active={filter === 'completed'} on:click={() => filter = 'completed'}>Completed</button>
    </div>

    {#if isLoading}
        <p class="loading">Loading tasks...</p>
    {:else}
        <ul class="todo-list">
            {#each filteredTodos as todo (todo.id)}
                <li transition:fly={{ y: 20, duration: 300 }} class:completed={todo.completed}>
                    <label>
                        <input 
                            type="checkbox" 
                            checked={todo.completed}
                            on:change={() => toggleTodo(todo.id)}
                        />
                        <span class="text">{todo.text}</span>
                    </label>
                    <button class="delete-btn" on:click={() => deleteTodo(todo.id)}>✕</button>
                </li>
            {/each}
        </ul>
        <div class="footer">
            <span>{remainingCount} item{remainingCount !== 1 ? 's' : ''} left</span>
            {#if todos.some(t => t.completed)}
                <button on:click={() => todos = todos.filter(t => !t.completed)}>
                    Clear completed
                </button>
            {/if}
        </div>
    {/if}
</div>
`
    },
    shell: {
        ext: '.sh',
        code: `
#!/bin/bash

# Configuration
LOG_FILE="/var/log/backup_script.log"
BACKUP_DIR="/backup"
SOURCE_DIRS=("/etc" "/var/www" "/home")
RETENTION_DAYS=7

# Ensure script is run as root
if [[ $EUID -ne 0 ]]; then
   echo "This script must be run as root" 
   exit 1
fi

log_message() {
    local level=$1
    local message=$2
    local timestamp=$(date "+%Y-%m-%d %H:%M:%S")
    echo "[$timestamp] [$level] $message" | tee -a "$LOG_FILE"
}

create_backup() {
    local timestamp=$(date "+%Y%m%d_%H%M%S")
    local backup_name="system_backup_$timestamp.tar.gz"
    local dest_path="$BACKUP_DIR/$backup_name"

    log_message "INFO" "Starting backup process..."
    if [ ! -d "$BACKUP_DIR" ]; then
        log_message "INFO" "Creating backup directory $BACKUP_DIR"
        mkdir -p "$BACKUP_DIR"
    fi

    # Create the tar archive
    tar -czf "$dest_path" "\\\${SOURCE_DIRS[@]}" 2>> "$LOG_FILE"
    local status=$?

    if [ $status -eq 0 ]; then
        log_message "SUCCESS" "Backup completed successfully: $dest_path"
    else
        log_message "ERROR" "Backup failed with exit code $status"
        exit 2
    fi
}

cleanup_old_backups() {
    log_message "INFO" "Cleaning up backups older than $RETENTION_DAYS days..."
    # Find and delete old backups
    find "$BACKUP_DIR" -name "system_backup_*.tar.gz" -type f -mtime +$RETENTION_DAYS -delete 2>> "$LOG_FILE"
    if [ $? -eq 0 ]; then
        log_message "SUCCESS" "Cleanup completed"
    else
        log_message "WARNING" "Cleanup encountered an error"
    fi
}

# Main Execution
log_message "INFO" "=== Backup Job Started ==="
create_backup
cleanup_old_backups
log_message "INFO" "=== Backup Job Finished ==="
`
    }
};

for (const [lang, data] of Object.entries(languages)) {
    fs.writeFileSync(path.join(targetDir, lang + '_light' + data.ext), data.code);
    fs.writeFileSync(path.join(targetDir, lang + '_default' + data.ext), data.code);
    fs.writeFileSync(path.join(targetDir, lang + '_full' + data.ext), data.code);
}
console.log('Production fixtures generated successfully.');
