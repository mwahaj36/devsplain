
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
