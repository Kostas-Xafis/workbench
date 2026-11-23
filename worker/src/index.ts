/**
 * The cloud board's Worker (docs/cloud.md): every request goes to the one Durable Object that holds the board, which
 * checks who it's from and answers it (board.ts). Static files in ui/ are an asset binding the board reads from;
 * none is served without going through it (run_worker_first).
 */
import { Board, type Env } from "./board";

export { Board };

export default {
	fetch(req: Request, env: Env): Promise<Response> {
		return env.BOARD.get(env.BOARD.idFromName("board")).fetch(req);
	},
};
