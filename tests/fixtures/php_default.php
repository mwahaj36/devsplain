
<?php

namespace App\Services;

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
