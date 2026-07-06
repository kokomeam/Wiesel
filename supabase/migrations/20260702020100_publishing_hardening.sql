-- Advisor follow-up: pin the search_path of the publication immutability
-- trigger function (function_search_path_mutable WARN).
alter function private.enforce_publication_immutable() set search_path = public;
