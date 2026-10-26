// The edge of the first-person arena: a tall see-through ring that darkens
// everything seen through it, so the area you can flee into reads as "outside".
// Fades out towards the top so it melts into the sky.
shader_type spatial;
render_mode unshaded, cull_disabled, depth_draw_never, blend_mix, shadows_disabled;

uniform vec4 tint : source_color = vec4(0.02, 0.01, 0.01, 0.6);
uniform float fade_top = 40.0; // world height where the ring has faded away
uniform float fade_length = 30.0;

varying float world_y;

void vertex() {
	world_y = (MODEL_MATRIX * vec4(VERTEX, 1.0)).y;
}

void fragment() {
	ALBEDO = tint.rgb;
	ALPHA = tint.a * (1.0 - smoothstep(fade_top - fade_length, fade_top, world_y));
}
