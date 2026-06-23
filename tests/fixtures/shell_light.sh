
#!/bin/bash

LOG_FILE="/var/log/backup_script.log"
BACKUP_DIR="/backup"
SOURCE_DIRS=("/etc" "/var/www" "/home")
RETENTION_DAYS=7

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

    tar -czf "$dest_path" "\${SOURCE_DIRS[@]}" 2>> "$LOG_FILE"
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
    find "$BACKUP_DIR" -name "system_backup_*.tar.gz" -type f -mtime +$RETENTION_DAYS -delete 2>> "$LOG_FILE"
    if [ $? -eq 0 ]; then
        log_message "SUCCESS" "Cleanup completed"
    else
        log_message "WARNING" "Cleanup encountered an error"
    fi
}

log_message "INFO" "=== Backup Job Started ==="
create_backup
cleanup_old_backups
log_message "INFO" "=== Backup Job Finished ==="
