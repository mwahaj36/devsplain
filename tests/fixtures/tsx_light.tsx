
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
