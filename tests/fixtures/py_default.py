
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
