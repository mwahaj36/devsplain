
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
