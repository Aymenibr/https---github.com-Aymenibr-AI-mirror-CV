import { redirect } from "next/navigation";

type PageProps = {
  params: { exercise?: string | string[] };
  searchParams?: Record<string, string | string[] | undefined>;
};

export default function ExerciseRedirectPage({ params, searchParams }: PageProps) {
  const rawValue = Array.isArray(params.exercise) ? params.exercise[0] : params.exercise ?? "";
  const exercise = decodeURIComponent(rawValue);

  const query = new URLSearchParams();
  Object.entries(searchParams ?? {}).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((v) => query.append(key, v));
    } else if (typeof value === "string") {
      query.append(key, value);
    }
  });
  const queryString = query.toString();
  const suffix = queryString ? `?${queryString}` : "";

  if (["press", "pushup", "overhead"].includes(exercise.toLowerCase())) {
    redirect(`/press${suffix}`);
  }

  redirect(`/squat${suffix}`);
}
