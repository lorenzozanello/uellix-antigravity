-- 20260716000000_auth_trigger.sql

-- Documentación:
-- El ciclo de vida de eliminación/anominización de usuarios será tratado 
-- exclusivamente en la política de retención de usuarios. Por tanto, no se 
-- define un trigger de DELETE.

CREATE OR REPLACE FUNCTION public.handle_new_user() 
RETURNS trigger 
SECURITY DEFINER SET search_path = '' 
LANGUAGE plpgsql AS $$
BEGIN
  IF new.email IS NULL THEN
    RAISE EXCEPTION 'Registro sin email no soportado en Uellix. (ID: %)', new.id;
  END IF;

  INSERT INTO public.users (id, email, full_name, avatar_url, is_super_admin)
  VALUES (
    new.id, 
    new.email, 
    new.raw_user_meta_data->>'full_name', 
    new.raw_user_meta_data->>'avatar_url', 
    false
  )
  ON CONFLICT (id) DO UPDATE SET 
    email = EXCLUDED.email,
    full_name = EXCLUDED.full_name,
    avatar_url = EXCLUDED.avatar_url,
    updated_at = now();

  RETURN new;
END;
$$;

-- Revoke execute from public roles
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- Drop existing trigger if any
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- Create AFTER INSERT trigger
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();


-- Create AFTER UPDATE trigger for email and metadata changes
CREATE OR REPLACE FUNCTION public.handle_update_user() 
RETURNS trigger 
SECURITY DEFINER SET search_path = '' 
LANGUAGE plpgsql AS $$
BEGIN
  IF new.email IS NULL THEN
    RAISE EXCEPTION 'Actualización a email NULL no soportada en Uellix. (ID: %)', new.id;
  END IF;

  UPDATE public.users 
  SET 
    email = new.email,
    full_name = new.raw_user_meta_data->>'full_name',
    avatar_url = new.raw_user_meta_data->>'avatar_url',
    updated_at = now()
  WHERE id = new.id;

  RETURN new;
END;
$$;

-- Revoke execute from public roles
REVOKE EXECUTE ON FUNCTION public.handle_update_user() FROM PUBLIC, anon, authenticated;

-- Drop existing trigger if any
DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;

-- Create AFTER UPDATE trigger on specific columns
CREATE TRIGGER on_auth_user_updated
  AFTER UPDATE OF email, raw_user_meta_data ON auth.users
  FOR EACH ROW 
  WHEN (old.email IS DISTINCT FROM new.email OR old.raw_user_meta_data IS DISTINCT FROM new.raw_user_meta_data)
  EXECUTE PROCEDURE public.handle_update_user();
