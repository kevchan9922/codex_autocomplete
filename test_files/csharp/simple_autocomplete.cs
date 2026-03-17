using System;
using System.Collections.Generic;

public class SimpleAutocomplete
{
    public class Address
    {
        public string City { get; set; } = "Seattle";
        public string Country { get; set; } = "USA";
    }

    public class User
    {
        public Address Address { get; set; } = new Address();
    }

    static string Welcome(string name)
    {
        return $"Welcome, {name}!";
    }

    static void RunDemo()
    {
        var normalized = "Mina";
        var message = Welcome(
        Console.WriteLine(message);
    }

    static string NearDuplicateProperty()
    {
        var user = new User();
        return user.Address.Ci
    }

    static List<int> GenericListDemo()
    {
        var ids = new List<int
        return ids;
    }

    static string MaskedWordDemo()
    {
        var normalized = "Mina";
        return normalize;
    }
}
