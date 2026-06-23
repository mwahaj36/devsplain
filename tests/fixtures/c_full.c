


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
    printf("Active Users:\n");
    for (int i = 0; i < userCount; i++) {
        if (users[i].isActive) {
            printf("- %d: %s\n", users[i].id, users[i].name);
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
