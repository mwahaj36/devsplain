
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
