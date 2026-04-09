import {
  SetWorldScale,
  b2DefaultWorldDef,
  CreateWorld,
  GetWorldScale,
  b2CreateBody,
  b2DefaultBodyDef,
  b2CreatePolygonShape,
  b2DefaultShapeDef,
  b2MakeBox,
  DYNAMIC,
  b2Body_GetLinearVelocity,
  b2Body_GetPosition,
  b2Body_SetLinearVelocity,
  b2CreateCircleShape,
  b2CreateWorld,
  b2DestroyWorld,
  b2World_GetGravity,
  b2World_Step,
  b2Vec2,
  b2BodyId,
  b2WorldId,
  b2CreateWorldArray,
  b2Body_SetTransform,
  b2Body_SetAngularVelocity,
  b2Body_GetRotation,
  b2Body_GetAngularVelocity,
  b2World_SetGravity,
  b2Rot,
} from "phaser-box2d";

const SCALE = 30;
const FIXED = 1 / 60;
let accumulator = 0;

export class Game extends Phaser.Scene {
  world!: b2WorldId;
  graphics!: Phaser.GameObjects.Graphics;
  body!: b2BodyId;
  predBody!: b2BodyId;
  predictionWorld!: b2WorldId;
  circle!: Phaser.GameObjects.Arc;
  groundRect!: Phaser.GameObjects.Rectangle;

  constructor() {
    super("Game");
  }

  create() {
    b2CreateWorldArray();
    this.initializePhysicsWorld();
    this.initializeGameElements();
  }

  initializePhysicsWorld() {
    // SetWorldScale(SCALE);
    const worldDef = b2DefaultWorldDef();
    this.world = b2CreateWorld(worldDef);
    this.predictionWorld = b2CreateWorld(worldDef); // separate world for trajectory prediction to avoid state interference
    const gravity = new b2Vec2(0, 0);
    b2World_SetGravity(this.world, gravity);
    b2World_SetGravity(this.predictionWorld, gravity);
  }

  initializeGameElements() {
    const groundDef = b2DefaultBodyDef();
    groundDef.position = new b2Vec2(10.0, 12.0);
    const ground = b2CreateBody(this.world, groundDef);
    const predGround = b2CreateBody(this.predictionWorld, groundDef);

    const groundShape = b2DefaultShapeDef();
    groundShape.restitution = 0.8;
    const groundBox = b2MakeBox(10.0, 1.0);
    b2CreatePolygonShape(ground, groundShape, groundBox);
    b2CreatePolygonShape(predGround, groundShape, groundBox);

    const bodyDef = b2DefaultBodyDef();
    bodyDef.type = DYNAMIC;
    bodyDef.position = new b2Vec2(9.0, 5.0);
    this.body = b2CreateBody(this.world, bodyDef);
    this.predBody = b2CreateBody(this.predictionWorld, bodyDef);

    const shapeDef = b2DefaultShapeDef();
    shapeDef.density = 1.0;
    shapeDef.restitution = 0.95;
    const circleDef = { radius: 1.0, center: new b2Vec2(0, 0) };
    b2CreateCircleShape(this.body, shapeDef, circleDef);
    b2CreateCircleShape(this.predBody, shapeDef, circleDef);

    const velocity = new b2Vec2(1, -5.0);
    b2Body_SetLinearVelocity(this.body, velocity);
    b2Body_SetLinearVelocity(this.predBody, velocity);

    this.circle = this.add.circle(
      bodyDef.position.x * SCALE,
      bodyDef.position.y * SCALE,
      circleDef.radius * SCALE,
      0xff0000,
    );

    this.groundRect = this.add.rectangle(
      groundDef.position.x * SCALE,
      groundDef.position.y * SCALE,
      20 * SCALE,
      2 * SCALE,
      0x00ff00,
    );

    this.graphics = this.add.graphics();
  }

  // addInput() {
  //   this.input.on("pointerdown", this.addLine, this);
  //   this.input.on("pointermove", this.moveLine, this);
  //   this.input.on("pointerup", this.clearLine, this);
  // }

  getTrajectoryPoints() {
    const points = [];
    const timeStep = 1.0 / 60.0;
    const position = b2Body_GetPosition(this.body);
    const velocity = b2Body_GetLinearVelocity(this.body);
    const rotation = b2Body_GetRotation(this.body);
    const angularVelocity = b2Body_GetAngularVelocity(this.body);

    // Sync prediction body to current state
    b2Body_SetTransform(
      this.predBody,
      new b2Vec2(position.x, position.y),
      new b2Rot(rotation.c, rotation.s),
    );
    b2Body_SetLinearVelocity(this.predBody, new b2Vec2(velocity.x, velocity.y));
    b2Body_SetAngularVelocity(this.predBody, angularVelocity);

    // Simulate and record positions
    for (let i = 0; i < 1800; i++) {
      let pos = b2Body_GetPosition(this.predBody);
      points.push(new b2Vec2(pos.x, pos.y));
      b2World_Step(this.predictionWorld, timeStep, 8);
    }

    return points;
  }

  update(time, delta) {
    accumulator += Math.min(delta / 1000, 0.25);

    while (accumulator >= FIXED) {
      b2World_Step(this.world, FIXED, 8);
      accumulator -= FIXED;
    }

    const position = b2Body_GetPosition(this.body);
    const velocity = b2Body_GetLinearVelocity(this.body);

    this.circle.setPosition(position.x * SCALE, position.y * SCALE);

    // Draw trajectory prediction

    try {
      const points = this.getTrajectoryPoints();

      this.graphics.clear();
      this.graphics.lineStyle(2, 0xff0000);
      for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];
        this.graphics.moveTo(p1.x * SCALE, p1.y * SCALE);
        this.graphics.lineTo(p2.x * SCALE, p2.y * SCALE);
      }
      this.graphics.strokePath();
    } catch (e) {
      console.error("Error in update:", e);
    }
  }
}
