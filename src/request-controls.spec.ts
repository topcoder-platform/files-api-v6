import express from 'express';
import request from 'supertest';
import { requestBudget } from './request-controls';

describe('Request budget before application work', () => {
  afterEach(() => {
    delete process.env.UPLOAD_REQUESTS_PER_SECOND;
    delete process.env.UPLOAD_REQUEST_BURST;
    jest.restoreAllMocks();
  });
  it('limits unauthenticated and malformed requests, preserves health probes, and refills over time', async () => {
    process.env.UPLOAD_REQUESTS_PER_SECOND = '1';
    process.env.UPLOAD_REQUEST_BURST = '2';
    const clock = jest.spyOn(performance, 'now').mockReturnValue(0);
    const app = express();
    app.use(requestBudget());
    const expensiveWork = jest.fn();
    app.use((req, res) => {
      if (req.path === '/v6/uploads/files/health') res.sendStatus(200);
      else {
        expensiveWork();
        res.sendStatus(401);
      }
    });
    await request(app)
      .post('/v6/uploads/files/sessions')
      .send('{bad')
      .expect(401);
    await request(app).get('/unknown').expect(401);
    await request(app)
      .post('/v6/uploads/files/sessions')
      .expect('Retry-After', '1')
      .expect(429);
    await request(app).get('/v6/uploads/files/health').expect(200);
    expect(expensiveWork).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(1000);
    await request(app).post('/v6/uploads/files/sign').expect(401);
    expect(expensiveWork).toHaveBeenCalledTimes(3);
  });
});
