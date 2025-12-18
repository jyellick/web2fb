const FramebufferQueue = require('../../lib/framebuffer-queue');

describe('FramebufferQueue', () => {
  let queue;

  beforeEach(() => {
    queue = new FramebufferQueue(10);
  });

  describe('enqueue/dequeue', () => {
    it('should enqueue and dequeue operations', () => {
      const operation = { type: 'full', buffer: Buffer.from('test'), displayTime: 1000 };
      queue.enqueue(100, operation);

      const result = queue.dequeue(100);
      expect(result).toEqual(operation);
    });

    it('should return null for non-existent operations', () => {
      const result = queue.dequeue(999);
      expect(result).toBeNull();
    });

    it('should remove operation after dequeueing', () => {
      queue.enqueue(100, { type: 'full' });
      queue.dequeue(100);

      const result = queue.dequeue(100);
      expect(result).toBeNull();
    });
  });

  describe('needsMore', () => {
    it('should return true when queue is empty', () => {
      expect(queue.needsMore(100)).toBe(true);
    });

    it('should return true when queue has fewer than windowSize operations', () => {
      for (let i = 0; i < 5; i++) {
        queue.enqueue(100 + i, { type: 'full' });
      }
      expect(queue.needsMore(100)).toBe(true);
    });

    it('should return false when queue has windowSize or more operations', () => {
      for (let i = 0; i < 10; i++) {
        queue.enqueue(100 + i, { type: 'full' });
      }
      expect(queue.needsMore(100)).toBe(false);
    });

    it('should only count future operations', () => {
      for (let i = 0; i < 10; i++) {
        queue.enqueue(100 + i, { type: 'full' });
      }
      // At second 105, only 5 operations are in the future (105-109)
      expect(queue.needsMore(105)).toBe(true);
    });
  });

  describe('getNextUnqueuedSecond', () => {
    it('should return current second when queue is empty', () => {
      expect(queue.getNextUnqueuedSecond(100)).toBe(100);
    });

    it('should return first gap in sequence', () => {
      queue.enqueue(100, { type: 'full' });
      queue.enqueue(101, { type: 'full' });
      // Gap at 102
      queue.enqueue(103, { type: 'full' });

      expect(queue.getNextUnqueuedSecond(100)).toBe(102);
    });

    it('should return next after last when no gaps', () => {
      for (let i = 0; i < 5; i++) {
        queue.enqueue(100 + i, { type: 'full' });
      }
      expect(queue.getNextUnqueuedSecond(100)).toBe(105);
    });
  });

  describe('getLastQueuedSecond', () => {
    it('should return null when queue is empty', () => {
      expect(queue.getLastQueuedSecond()).toBeNull();
    });

    it('should return the maximum queued second', () => {
      queue.enqueue(100, { type: 'full' });
      queue.enqueue(105, { type: 'full' });
      queue.enqueue(102, { type: 'full' });

      expect(queue.getLastQueuedSecond()).toBe(105);
    });
  });

  describe('getStatus', () => {
    it('should return correct status', () => {
      for (let i = 0; i < 5; i++) {
        queue.enqueue(100 + i, { type: 'full' });
      }

      const status = queue.getStatus(100);
      expect(status.size).toBe(5);
      expect(status.windowSize).toBe(10);
      expect(status.needsMore).toBe(true);
      expect(status.range).toBe('100 to 104');
      expect(status.secondsAhead).toBe(4);
    });
  });

  describe('clear', () => {
    it('should remove all operations', () => {
      for (let i = 0; i < 5; i++) {
        queue.enqueue(100 + i, { type: 'full' });
      }

      queue.clear();
      expect(queue.getStatus(100).size).toBe(0);
    });
  });
});
