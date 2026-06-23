

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
