
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
			fmt.Printf("Worker %d shutting down\n", id)
			return
		case job, ok := <-p.jobs:
			if !ok {
				return
			}
			fmt.Printf("Worker %d executing job %s\n", id, job.ID())
			err := job.Execute(p.ctx)
			if err != nil {
				fmt.Printf("Error executing job %s: %v\n", job.ID(), err)
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
